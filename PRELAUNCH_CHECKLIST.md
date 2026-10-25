# RandomMeet pre-launch checklist

Last reviewed: 2026-10-25

This document distinguishes code changes from tests that still require real devices, a configured TURN provider, durable storage, and an operator/moderator.

## Implemented in the current code

- [x] Report dialog offers a reason category and submits the current session ID.
- [x] Accepted reports end the chat and enter a bounded in-memory queue (maximum 500).
- [x] Token-protected `GET /admin/reports` endpoint and `/admin.html` console.
- [x] Browser-level Block & leave action; blocked browser IDs are stored locally and sent with future matching requests.
- [x] Avoid the last 20 browser IDs matched from the same browser to reduce immediate repeat matches.
- [x] Matching still checks both users' gender, nationality, and chat-mode preferences.
- [x] Added Content-Security-Policy, HSTS in production, and existing anti-framing/content-type/referrer/permissions headers.
- [x] Added Terms of Service draft and updated privacy/safety notices to describe actual behavior and limitations.
- [x] English UI source scan performed; no Chinese characters found in the checked application and policy files.
- [x] Existing HTTPS deployment and WebRTC connection/recovery code retained.

## Blocking issues before a broad public launch

- [ ] Replace the in-memory report queue with durable storage (e.g. a database) and implement report retention/deletion.
- [ ] Define and operate a real moderation workflow: who reviews reports, response times, escalation, appeals, and emergency/underage cases. The current report console is not staffed automatically.
- [ ] Publish the service operator's legal identity, monitored contact address, final privacy notice, and legally reviewed terms for target markets.
- [ ] Configure and test a TURN provider. Current source supports `TURN_URLS`, `TURN_SHARED_SECRET`, and optional `TURN_TTL_SECONDS`; without those environment variables it falls back to STUN only.
- [ ] Review abuse resistance: stable browser IDs can be cleared or changed and are not identity-level bans; add stronger server-side controls before broad launch.
- [ ] Confirm the Render `REPORT_ADMIN_TOKEN` is stored only as an environment secret and rotate it if exposed.

## Required manual QA

### Desktop browser
- [ ] Chrome/Edge and Firefox: video mode, voice mode, camera/microphone denial, playback, Next, End chat, Block & leave, Report.
- [ ] Verify the report appears in `/admin.html` while the process is running.
- [ ] Verify stale signaling from a previous match is ignored and a departed user is removed from the queue.

### iPhone / Safari
- [ ] HTTPS camera/microphone permissions, autoplay, screen lock/background behavior, orientation, cellular-to-Wi-Fi changes.
- [ ] Test video and voice mode; confirm ending or blocking stops local media tracks.

### Android / Chrome
- [ ] HTTPS permissions, autoplay, camera/microphone switching, mobile network changes, and layout.
- [ ] Test video and voice mode; confirm ending or blocking stops local media tracks.

### Matching and recovery
- [ ] Two users with mutually compatible preferences match.
- [ ] One-sided gender or nationality mismatch does not match.
- [ ] Different chat modes do not match.
- [ ] Blocked browser IDs and recently matched IDs are skipped.
- [ ] Refresh/disconnect while waiting or chatting clears stale state; the remaining user can find a new match.
- [ ] Test at least one restrictive network with TURN configured and verify the selected ICE candidate type.

### Operational checks
- [ ] Confirm `/health` returns `{ "ok": true }`.
- [ ] Confirm `/ice-config` returns STUN servers and, once configured, short-lived TURN credentials.
- [ ] Confirm `/admin/reports` rejects requests without the correct token.
- [ ] Test a deploy and a service restart; note that in-memory reports are currently lost.
- [ ] Review logs for errors without logging media or unnecessary personal data.

Do not treat the service as ready for broad public launch until all blocking issues and required manual QA items are resolved.
