# Supabase to Yandex Cloud migration runbook

Supabase remains untouched until the Yandex production API has worked for 14
days. Never delete the Supabase project as part of the migration scripts.

1. Connect through VPN and set `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `ROOM_PASSPHRASE`, and optionally `ROOM_SLUG`/`EXPORT_DIR`.
2. From `backend`, run `pnpm export-supabase` and then `pnpm verify-export`.
3. Store the resulting untracked `migration/export` directory encrypted. It
   contains private photos and memories.
4. Apply `backend/schema.yql` to test YDB.
5. Generate two account bootstrap statements with `pnpm create-user --
   --username ... --display-name ... --password ...`; redirect output to an
   untracked file and apply it in YDB. Do not share passwords in Git or chat.
6. Set `YDB_ENDPOINT`, `YDB_DATABASE`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
   `S3_SECRET_ACCESS_KEY`, then run `pnpm import-yandex`. The idempotent import
   preserves UUIDs and timestamps, checks every file before upload, and uses the
   `legacy` system user because anonymous Supabase authors cannot be mapped
   reliably to the two new accounts.
7. Compare row counts, byte sizes and SHA-256 values with `manifest.json`.
8. Repeat the export immediately before cutover while the old UI is read-only.
9. Change `api-config.js` only after the test API passes the acceptance suite.
10. Keep Supabase for 14 days, take a final encrypted archive, and request a
    separate confirmation before disabling or deleting anything.
