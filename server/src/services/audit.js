export function recordAudit(
  db,
  { actorUserId = null, action, entityType, entityId, before = null, after = null, reason = null }
) {
  const stmt = db.prepare(`
    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_json, after_json, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    actorUserId,
    action,
    entityType,
    entityId,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    reason
  );
  return info.lastInsertRowid;
}
