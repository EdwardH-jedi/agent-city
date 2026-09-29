-- 004_github_etags: conditional-request cache for GitHub REST calls (304 → reuse `body`).
-- `body` holds only the derived fields we use (e.g. CI {status, conclusion, updated_at}),
-- never the raw API response.

CREATE TABLE github_etags (
  url         TEXT PRIMARY KEY,
  etag        TEXT NOT NULL,
  body        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
