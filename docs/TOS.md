# Terms of Service

All users are subject to the Terms of Service regardless of how they authenticate.

**Google-authenticated and email/password users** must explicitly accept via the ToS modal — shown on first login and re-shown if a user attempts to generate without having accepted. Acceptance is recorded server-side in `users.tos_accepted_at` and `users.tos_version`.

`TOS_VERSION` is derived from a hash of `server/src/tos-content.js`, so acceptance is current only when `users.tos_version === TOS_VERSION`.

**Access code users** are bound by the same terms upon first use of the Service. The client shows the same modal, but acceptance is not persisted server-side because code-user sessions do not have a `users` row. Admins issuing `job_access` codes are expected to make recipients aware of the terms before distribution.

The terms operate under the following legal framework:

| Topic | Instrument |
|-------|-----------|
| Contract formation | § 1724 et seq. of Act No. 89/2012 Coll. (Czech Civil Code) |
| Data protection | Regulation (EU) 2016/679 (GDPR) supplemented by Act No. 110/2019 Coll. |
| Prohibited content | Act No. 40/2009 Coll. (Czech Criminal Code), Regulation (EU) 2024/1689 (AI Act) |
| Governing law | Czech Republic — disputes resolved by Czech courts |
