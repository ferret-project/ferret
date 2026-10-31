# Account security

All of this is in **Household & settings → Security**.

## Passkeys

A **passkey** signs you in with Face ID, Touch ID, Windows Hello or a security key — no password to type, and nothing a
fake site can steal. **Add a passkey** on the device you want to use (an iPhone's or Mac's passkeys sync through
iCloud Keychain, so one is often enough), then choose **Sign in with a passkey** on the sign-in page, or pick it from
the suggestions under Email. A passkey counts as both steps of two-step sign-in.

Adding one needs a sign-in from the last day — if it's been longer, sign out and back in first. Ferret tells you
whenever a passkey is added (push, your other apps, email). **Remove** takes one away.

## Email me a sign-in link

When the server can send email, **Email me a sign-in link** on the sign-in page sends a link that signs you in — it works
once, for 15 minutes. It never makes a new account (that still takes an invitation), and it isn't offered to accounts
with two-step sign-in: those use their password and code, or a passkey. (On an iPhone the link opens in Safari; to sign
in to the installed app, use a passkey or your password there.)

## Two-step sign-in

Turn it on to need a code from an authenticator app (Apple Passwords, 1Password, Google Authenticator…) as well as your
password. You get **backup codes** too — keep them somewhere safe; each works once if you lose your phone.

## Sessions and sign-ins

See where you're signed in, and sign one or all other sessions out. **Recent sign-ins** lists when and from where your
account was signed in to — if you don't recognise one, change your password.

## Wrong passwords

After 5 wrong passwords for an account, Ferret makes you wait a minute, then 5 minutes, and after that each try needs
your browser to solve a small puzzle first (it takes a few seconds). It never locks you out completely. **Email me a
link to sign in again** clears the waiting. The owner hears about repeated failures.

## Forgot your password

**Forgot your password?** on the sign-in page emails a link to choose a new one (when the server can send email). Changing
it signs you out everywhere else and tells you by email.

## Sign-ins from somewhere new

When your account is signed in to from a network it hasn't been used from before, Ferret tells you — on your phone
(push), in your other apps, and by email if it can send it: which device, from what address, and when. If it wasn't
you, change your password and use **Sign out all other sessions** above.

## Deleting your account

**Settings → Security → Delete your account** deletes your account for good, with any household only you are in; the
households you share stay with the others. Type your email address and your password to confirm (an account without a
password — passkeys or emailed links only — needs a sign-in in the last 15 minutes). If others are in a household you
own, make one of them its owner, or delete the household, first. The server's admin hands that role over first too.
With no household, the "Name your household" screen offers it as well.

What's deleted is gone from Ferret straight away; the server's backups still hold it until they age out.
