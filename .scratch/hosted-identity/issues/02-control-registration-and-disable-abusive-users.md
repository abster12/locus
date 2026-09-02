# 02: Control registration and disable abusive users

**What to build:** Let any judge or visitor with Google create a free Locus account throughout the WebMCP Challenge judging window, while preserving an operator switch that can stop new accounts after judging or during a genuine safety incident without locking out existing users. A specific abusive user can be disabled immediately even when their Better Auth session has not expired.

**Blocked by:** 01: Sign in with Google and return to one Library

**Status:** resolved

- [x] Registration supports `open` and `closed` modes controlled only by the hosted environment.
- [x] The submitted environment defaults to open registration and documents that it must remain free and available through September 21, 2026 at 5:00 pm PDT unless an alternative judge-access path is supplied.
- [x] In open mode, a new Google identity receives an active user record, one private Library, and one owner membership.
- [x] In closed mode, an existing user can still sign in and recover the same Library.
- [x] In closed mode, a new Google identity receives a generic registration-closed result and no accessible Library.
- [x] A disabled user receives `403` on every private request even if its authentication cookie remains valid.
- [x] The browser cannot select or override registration mode or user-access status.
- [x] Registration and access-denied responses do not reveal whether an arbitrary Google identity already has a Locus account.
- [x] Google OAuth remains identity-only and account linking remains disabled.
- [x] Tests cover open registration, repeat login, closing registration, existing-user login while closed, new-user rejection while closed, disabled existing sessions, and reopening registration.

## Answer

`REGISTRATION_MODE` is a Worker var (`open` default, `closed` stops new Google sign-ups via Better Auth `disableSignUp`). Existing users keep their Library. First `/api/session` writes `user_access`; `disabled` returns generic `403` with a still-valid cookie. Operator disable is a D1 update on `user_access`, not an admin UI.
