// Cloudflare Pages Functions — Helper Batas Paket Langganan
// Dipakai bersama oleh projects.js (batas jumlah proyek) dan collab.js (batas kolaborator).
// Paket & start_date dibaca real-time dari tabel `subscription` (per-akun, prefix "u<id>:").
// Langganan berbayar yang kedaluwarsa (Bulanan 30 hari / Tahunan 365 hari dari start_date)
// otomatis turun ke Starter supaya limit tidak bisa "numpang" selamanya.

export const PLAN_LIMITS = {
  Starter: { projectLimit: 3, collaboratorLimit: 1 },
  Pro: { projectLimit: 10, collaboratorLimit: 5 },
  Bisnis: { projectLimit: 50, collaboratorLimit: 20 }
};

export async function getEffectivePlan(db, user) {
  const fallback = { plan: 'Starter', limits: PLAN_LIMITS.Starter, expiredFrom: null };
  try {
    if (!db || !user || !user.id) return fallback;
    const pfx = 'u' + user.id + ':';
    const rows = await db.prepare(
      'SELECT key, value FROM subscription WHERE key IN (?, ?, ?)'
    ).bind(pfx + 'plan', pfx + 'start_date', pfx + 'billing_cycle').all();
    const m = {};
    for (const r of rows.results || []) m[r.key.slice(pfx.length)] = r.value;
    let plan = (m.plan && PLAN_LIMITS[m.plan]) ? m.plan : 'Starter';
    let expiredFrom = null;
    if (plan !== 'Starter') {
      const start = m.start_date ? new Date(String(m.start_date).replace(' ', 'T')) : null;
      const days = (m.billing_cycle === 'Tahunan') ? 365 : 30;
      if (start && !isNaN(start.getTime()) && (Date.now() - start.getTime()) > days * 86400000) {
        expiredFrom = plan;
        plan = 'Starter';
      }
    }
    return { plan, limits: PLAN_LIMITS[plan], expiredFrom };
  } catch (e) {
    return fallback;
  }
}

export async function countProjects(db, userId) {
  try {
    const r = await db.prepare('SELECT COUNT(*) AS c FROM user_projects WHERE user_id = ?').bind(userId).first();
    return r?.c || 0;
  } catch (e) { return 0; }
}

export async function countProjectMembers(db, projectId) {
  try {
    const r = await db.prepare('SELECT COUNT(*) AS c FROM project_members WHERE project_id = ?').bind(projectId).first();
    return r?.c || 0;
  } catch (e) { return 0; }
}

export async function countPendingInvites(db, projectId) {
  try {
    const r = await db.prepare("SELECT COUNT(*) AS c FROM collab_invites WHERE project_id = ? AND status = 'pending'").bind(projectId).first();
    return r?.c || 0;
  } catch (e) { return 0; }
}
