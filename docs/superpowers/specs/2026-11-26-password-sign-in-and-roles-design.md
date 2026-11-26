# Password sign-in and roles: design

Status: approved by the owner in conversation on 2026-11-26. It amends the UI's design (`2026-11-25-the-ui-design.md`, section 3.2 and section 8) and builds on the UI's first plan as merged (`2026-11-25-the-ui-sign-in-and-activity.md`).

## 1. What it is for

The UI's first plan lets people in only through the GitHub App's own sign-in. That needs a callback URL and a client secret set on the app's settings page, and some operators do not want either. This change adds accounts of the service's own, with a name and a password, beside GitHub sign-in, and two roles, so that the people who may change the service are not every person who may look at it.

## 2. What the owner decided

Quoted or restated from the conversation of 2026-11-26:

- **O-PW-1.** Password sign-in is added **beside** GitHub sign-in, not in its place.
- **O-PW-2.** Two roles "for now": **Admin** and **Viewer**. "Viewers can't see settings."
- **O-PW-3.** Roles are set in the UI: "Admin can change roles, and create accounts through the UI."
- **O-PW-4.** "Signing in through GitHub defaults to Viewer."
- **O-PW-5.** The rest of the description played back to him was approved as written ("Approved"): the calls marked "the builder's" below were part of it.

## 3. Goals, non-goals, anti-goals

- **Goals.** A deployment can open the UI with password accounts only, with no GitHub callback URL and no client secret. Each person has their own account and role. An admin creates accounts, changes roles, resets passwords and removes accounts in the UI. A viewer sees everything an admin sees except Settings.
- **Non-goals.** Email, invitations by link, "forgot password", two-factor sign-in, single sign-on other than GitHub, more than two roles, per-repository permissions. The Settings screens themselves (they are the UI's next plans).
- **Anti-goals.** Anything that could lock every admin out from inside the UI; a password, a one-time password or a hash in any log line, answer (but the one-time password's single showing) or error; a viewer reaching an admin's data through the API even when the page hides it.

## 4. The design

### 4.1 Turning the UI on (the builder's call)

- The UI is **on when `ui.publicUrl` is written**. With `ui.publicUrl` alone, password sign-in is the only way in, and `app.clientId` and `app.clientSecret` are not needed.
- **GitHub sign-in is on when `ui.accounts` or `ui.team` is named**, as today, and then `ui.publicUrl`, `app.clientId` and `app.clientSecret` must be written (today's refusal, unchanged).
- With no `ui` block, or a `ui` block with neither `publicUrl` nor accounts nor team, the UI is off and `/ui/` and `/api/` answer 404, as today.
- `ui.accounts` and `ui.team` keep deciding who may sign in **through GitHub**; they no longer decide anyone's role. They stay in the file until the Settings plan makes the file's settings editable in the UI.

### 4.2 Accounts

- A table of accounts, one row per person: how they sign in (`password` or `github`), their name, their role (`admin` or `viewer`), when it was made and by whom, and when they last signed in.
- **A password account's name** is 1 to 39 characters: lower-case letters, digits, `.`, `_` and `-`, starting with a letter or a digit, unique among password accounts. A GitHub account's name is the GitHub login, unique among GitHub accounts, letter case aside. The two kinds are told apart wherever a name is shown (a GitHub mark beside a GitHub account).
- **A GitHub account's row is made at its first sign-in**, as a viewer (O-PW-4). An admin may then change its role; the row keeps it for every later sign-in, by login. (As in the first plan, a person is their login: a login freed and registered again by someone else would get the row's role. Recorded in the notes, not changed here.)
- **The last admin cannot be removed or made a viewer**, by anyone, by any route. With no admin at all (a fresh database), only the command of 4.6 can make one. (The builder's call, from the design's check:) an admin counts toward this rule unless it is a password account that has not yet chosen its own password, so an admin cannot step down in favour of a new admin who has not signed in yet. A GitHub admin counts whatever the file says now, so no role change waits on a GitHub read; the cost: removing a GitHub admin's login from the file while it is the only admin, or turning GitHub sign-in off (no account and no team left) while a GitHub admin is the only admin, leaves only the command as the way back in.
- Removing an account deletes its row and ends all of its sessions at once. A removed GitHub account that the file still lets in comes back as a new viewer at its next sign-in.
- An admin cannot reset their own account in the UI; a reset keeps the role, so the last-admin rule does not refuse it.
- At most 1,000 accounts.

### 4.3 Password sign-in (the builder's calls)

- **Creating an account** (admin, in the UI): a name and a role. The service makes a **one-time password** of 20 random characters (from an alphabet without look-alike characters) and answers it **once**; the UI shows it once with a button to copy it, and it is never shown or stored again in clear. It expires 72 hours after it was made.
- **The first sign-in** with a one-time password does not open a session: the person must choose their own password in the same step (the sign-in page asks for it), and only then is a session made. An expired one-time password is refused; an admin resets it. An expired one-time password reads as expired, but only once it was verified.
- **A password** is 12 to 128 characters, counted as code points, well formed (no lone surrogate) and with no U+0000 (NUL), and no other rule: scrypt pads a short key with zero bytes and writes every lone surrogate as U+FFFD, so either would make two passwords one. A password typed at sign-in is verified whatever it holds. It is stored only as a scrypt hash with its own random salt and its parameters (N = 2^15, r = 8, p = 1, 32 bytes), compared in constant time.
- **Wrong passwords.** After 5 wrong passwords in a row an account waits 15 minutes before any password is tried again; a right one resets the count. Every refusal answers the same sentence and takes about the same time, whether the name exists, the password is wrong or the account waits (a name that does not exist is checked against a hash made at start, so its time is the same; should that hash fail to be made, the next sign-in makes it again, and a sign-in that meets the failure fails alike whatever the name, before any account is read). The cost: someone who knows a name can keep that account waiting; an admin can still reset it.
- **Changing one's own password** (any password account, in the UI): the current password and the new one. It ends the account's other sessions.
- **A reset** (admin, in the UI): a new one-time password, answered once, as at creation; it ends all of the account's sessions.

### 4.4 GitHub sign-in

As built in the first plan (PKCE, the state's cookie, the team read), with two changes: a session now belongs to an account row (made at the first sign-in, a viewer), and its role is the row's. A GitHub account has no password and cannot be reset; it can change role or be removed.

### 4.5 Sessions and roles

- A session belongs to one account. **The role is read from the account's row at each request**, so a role change takes effect at the person's next request, and a removed account's sessions end at once.
- A GitHub session still ends when the way it was let in (a named login, or the team) no longer holds in the file, as today.
- **Roles are enforced by the API, not by the page.** A viewer is answered 403 `forbidden` by every admin route (accounts today, settings when they come), whatever the page shows. Every route that changes something needs a session and the token for changes (as today).
- **Requests that change something without a session** (the password sign-in and the first password) are accepted only with JSON and an `Origin` equal to `ui.publicUrl`, so a page of another site cannot sign a browser in.
- The sign-in routes keep their own 2 places, the rest of the API its 4.

### 4.6 The first admin, and a way back in (the builder's call)

A command run where the service runs, with the service's config. It reads the whole config, as the service does, and uses only the database's address and whether GitHub sign-in is on:

- make a password account with a role, printing its one-time password once;
- reset a password account, printing a new one-time password once (for both, the name given is lower-cased before it is checked);
- set the role of a GitHub login (making its row if it has none), so that a deployment with GitHub sign-in only can have its first admin before anyone signs in; refused while GitHub sign-in is off, since such an account could never sign in.

It is the only way to make the first admin, and the way back in if every admin's password is lost. It refuses to leave no admin, as the UI does.

### 4.7 The screens

The look follows the approved mockups (cards, tables, inputs, buttons, badges, both themes); no new mockup is drawn.

- **Sign-in page.** A name and a password, and "Sign in". When GitHub sign-in is on, below it, "Sign in with GitHub" as today. One sentence for every refusal. With a one-time password, the page then asks for a new password twice and signs in.
- **Sidebar.** The Settings entry is shown to admins only. The user block shows the name, how they signed in, and for a password account a "Change password" action.
- **Settings, for admins.** The Settings page opens on **Accounts**: a table of the accounts (name, how they sign in, role, last sign-in, made), "New account" (name and role, then the one-time password shown once), and per row: change role, reset password (password accounts), remove (with a confirmation). The other sections of Settings stay "Coming in a later plan". A viewer who opens `/ui/settings` sees the not-found page.
- **Change password** (a small page or dialog): the current password, the new one twice.

### 4.8 What is logged

One JSON line per sign-in (`ui_signin`: the way, the outcome, a short reason), and one per change to an account (`ui_account`: what was done (made, role, reset, removed, password changed) and the new role). As in every plan before, no log line holds a name or a login, and never a password, a one-time password, a hash, a session id or a token; a refused password sign-in logs the outcome only, so a password typed into the name field is never logged. (The builder's call, from the design's check:) who did what to whom is kept in the database instead, in a record of account changes: when, who did it (the name and kind, kept as text so the record outlives a removed account, or "the command"), the change, the account it was made to (name and kind, as text) and the new role. Nothing in it is secret. This plan writes it and the README gives the statement that reads it; a screen for it comes with the Settings plan's record of changes (UI design 4.4). A GitHub row made at its first sign-in is recorded as made by `sign_in`; a first password is recorded as `password_changed`.

## 5. What is left to the builder

Table and column names, the migration, the routes' paths and shapes, the command's name and arguments, the exact texts of the new screens (in the voice of the first plan's texts), how the one-time password's alphabet is drawn, the hash made at start for unknown names, and how the tests reach each rule. Each is a call written in the plan.

## 6. Not in this change

The Settings screens and the settings in the database (the next plans); the review page (the UI's plan 1b); email of any kind; a lockout per address; changing a password account's name; an audit screen of account changes (the log lines carry them).

## 7. Changes to the UI's design

- **3.2, Who may open it:** the UI is on when `ui.publicUrl` is written; password accounts are made in the UI and by a command; `ui.accounts` and `ui.team` decide who may sign in through GitHub. "Access is read from the file only" becomes: GitHub access is read from the file; password accounts and every role live in the database, and the last admin cannot be removed.
- **3.2, Who may change settings:** admins only; viewers see everything but Settings.
- **8, Not in this stage:** "Roles: everyone who may open the UI may change settings" is removed.
