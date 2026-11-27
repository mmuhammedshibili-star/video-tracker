import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });

type To = "editor" | "uploader" | "doctor";
// event -> required stage(s), who gets it, title (video / reel)
const EVENTS: Record<string, { stages: string[]; to: To[]; title: string; reel: string }> = {
  new:        { stages: ["new"],                  to: ["editor"],          title: "🎬 പുതിയ വീഡിയോ",        reel: "🎞️ പുതിയ റീൽ" },
  discussion: { stages: ["discussion"],           to: ["doctor"],          title: "💬 ഡിസ്കഷനിൽ ഇട്ടു",       reel: "💬 റീൽ ഡിസ്കഷനിൽ" },
  changes:    { stages: ["discussion","editing"], to: ["editor"],          title: "✍️ പുതിയ മാറ്റങ്ങൾ",        reel: "✍️ റീലിൽ മാറ്റങ്ങൾ" },
  confirmed:  { stages: ["confirmed"],            to: ["editor","doctor"], title: "✅ കൺഫേം ചെയ്തു",          reel: "✅ റീൽ കൺഫേം" },
  ready:      { stages: ["ready"],                to: ["uploader"],        title: "⬆️ അപ്‌ലോഡ് ചെയ്യാനുണ്ട്",  reel: "⬆️ റീൽ അപ്‌ലോഡ് ചെയ്യാനുണ്ട്" },
  done:       { stages: ["done"],                 to: ["doctor"],          title: "🎉 അപ്‌ലോഡ് ചെയ്തു",       reel: "🎉 റീൽ അപ്‌ലോഡ് ചെയ്തു" },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    const { data: cfg } = await admin.from("push_config").select("*").eq("id", 1).maybeSingle();
    if (!cfg) return j({ ok: false, error: "Push not configured" }, 500);

    if (body.action === "public_key") return j({ ok: true, publicKey: cfg.vapid_public });

    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return j({ ok: false, error: "Login again" }, 401);
    const { data: me } = await admin.from("video_team").select("*").eq("user_id", u.user.id).eq("is_active", true).maybeSingle();
    if (!me) return j({ ok: false, error: "Not a team member" }, 403);

    if (body.action === "subscribe") {
      const s = body.subscription || {};
      const endpoint = String(s.endpoint || ""), p256dh = String(s.keys?.p256dh || ""), auth = String(s.keys?.auth || "");
      if (!endpoint.startsWith("https://") || endpoint.length > 1500 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return j({ ok: false, error: "Bad subscription" }, 400);
      const { error } = await admin.from("push_subs").upsert({ user_id: me.user_id, endpoint, p256dh, auth }, { onConflict: "endpoint" });
      return error ? j({ ok: false, error: error.message }, 500) : j({ ok: true });
    }
    if (body.action === "unsubscribe") {
      if (body.endpoint) await admin.from("push_subs").delete().eq("endpoint", String(body.endpoint)).eq("user_id", me.user_id);
      return j({ ok: true });
    }

    webpush.setVapidDetails(cfg.subject, cfg.vapid_public, cfg.vapid_private);
    const send = async (userIds: string[], payload: Record<string, unknown>) => {
      if (!userIds.length) return { sent: 0, devices: 0 };
      const { data: subs } = await admin.from("push_subs").select("id,endpoint,p256dh,auth").in("user_id", userIds);
      let sent = 0; const dead: number[] = [];
      await Promise.all((subs || []).map(async (s: any) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400, urgency: "high" });
          sent++;
        } catch (e: any) { if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s.id); }
      }));
      if (dead.length) await admin.from("push_subs").delete().in("id", dead);
      return { sent, devices: (subs || []).length };
    };

    // housekeeping: thumbnails + SEO of videos finished more than 7 days ago are erased
    const cleanup = async () => {
      const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
      const { data: old } = await admin.from("videos").select("id,yt_thumb_path,ig_thumb_path,fb_thumb_path,seo_title,seo_desc,seo_tags,fb_caption")
        .eq("stage", "done").lt("posted_at", cutoff)
        .or("yt_thumb_path.not.is.null,ig_thumb_path.not.is.null,fb_thumb_path.not.is.null,seo_title.not.is.null,seo_desc.not.is.null,seo_tags.not.is.null,fb_caption.not.is.null").limit(50);
      if (!old?.length) return 0;
      const paths = old.flatMap((v: any) => [v.yt_thumb_path, v.ig_thumb_path, v.fb_thumb_path]).filter(Boolean);
      if (paths.length) await admin.storage.from("vt-assets").remove(paths);
      await admin.from("videos").update({ yt_thumb_path: null, ig_thumb_path: null, fb_thumb_path: null, seo_title: null, seo_desc: null, seo_tags: null, fb_caption: null }).in("id", old.map((v: any) => v.id));
      return old.length;
    };

    if (body.action === "test") {
      const r = await send([me.user_id], { title: "🔔 Notification ഓൺ ആണ്", body: "Misriyya Video Tracker", tag: "test" });
      return j({ ok: true, ...r });
    }

    if (body.action === "notify") {
      const ev = EVENTS[String(body.event || "")];
      if (!ev) return j({ ok: false, error: "Bad event" }, 400);
      const { data: v } = await admin.from("videos").select("id,title,stage,doctor_id,kind").eq("id", String(body.video_id || "")).maybeSingle();
      if (!v) return j({ ok: false, error: "Video not found" }, 404);
      if (!ev.stages.includes(v.stage)) return j({ ok: true, skipped: "stage changed" });
      const ids = new Set<string>();
      if (ev.to.includes("doctor")) ids.add(v.doctor_id);
      const roles = ev.to.filter((r) => r !== "doctor");
      if (roles.length) {
        const { data: t } = await admin.from("video_team").select("user_id").in("role", roles).eq("is_active", true);
        (t || []).forEach((x: any) => ids.add(x.user_id));
      }
      ids.delete(me.user_id);
      const { data: doc } = await admin.from("video_team").select("display_name").eq("user_id", v.doctor_id).maybeSingle();
      const title = v.kind === "reel" ? ev.reel : ev.title;
      await cleanup().catch(() => 0);
      const r = await send([...ids], { title, body: `${v.title} · ${doc?.display_name || ""}`, tag: `v-${v.id}`, url: `./?v=${v.id}` });
      return j({ ok: true, ...r });
    }
    return j({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    return j({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
