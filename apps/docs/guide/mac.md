# On your Mac: Ferret Menu

**Ferret Menu** puts Ferret in your Mac's menu bar, behind a paw: find anything you own from any app, see what needs
doing, ask about your things, and add new ones by dropping their photos and receipts on the paw. It's a small free app
of its own ([ferret-project/ferret-menu](https://github.com/ferret-project/ferret-menu), open source) that talks to your
Ferret. Anything it doesn't do opens in Ferret, in your browser or [Ferret's web app](#opening-things-in-ferret-s-web-app).

It needs **macOS 26** and **Ferret 2026.11.29 or newer**.

## Installing

Download **Ferret-Menu.zip** from its
[releases](https://github.com/ferret-project/ferret-menu/releases), unzip it and move **Ferret Menu** to
**Applications**.

Ferret Menu isn't notarized by Apple yet, so the first time, macOS says it can't check it. Try to open it once, then go
to **System Settings → Privacy & Security** and choose **Open Anyway**. You only do this once: updates install by
themselves after that.

## Signing in

Click the paw. Ferret Menu signs in through your Ferret's own sign-in page, in a small sign-in window: you sign in as
usual, pick the household, and choose whether it may **add and change things** or only search and ask. It never sees
your password and takes no API keys.

- **Your own Ferret**: open **Self-hosted server** and type its address. An address is `https://` unless you type
  `http://`, so a Ferret on plain HTTP at home is `http://192.168.1.20:8787`. With the address left empty, **Sign In**
  goes to the hosted Ferret.
- **Behind Cloudflare Access**: open **Cloudflare Access** and enter a service token's **Client ID** and **Client
  secret** (how to make one: [service tokens](../hosting/tunnels#scripts-and-claude-service-tokens)). Unlike the web
  app on a phone ([why that can't use one](../hosting/phone-app#what-can-t-work-service-tokens)), Ferret Menu sends the
  token itself with everything it asks for. Ferret Menu remembers it for that server, even after signing out.

Each Mac shows up in Ferret under **Claude & API → Connected apps** as **Ferret Menu on** *your Mac's name*.
**Disconnect** there signs it out at once. A viewer's Ferret Menu can only look.

## Using it

Click the paw, or press **⌃⌥⌘F** from any app (change the shortcut in **Settings**). The screens are icons along the
top; **⌘1**, **⌘2**… switch between them.

### Search

Type, and things appear as you go: by name, brand, what it's for, or what's in its photos and documents, the same
[search](./finding-things) as in Ferret. **↑** and **↓** move through the results and **Return** opens one in Ferret.
Right-click a thing to **Copy Where It Is** or **Copy Link**.

With nothing typed, it shows the top of **Needs attention** and the things you opened lately.

### Needs attention

The same list as Ferret's [bell](./attention): warranties ending, maintenance due, recalls, loans and the rest. The
number beside the paw is how many are **urgent**, and macOS tells you when something **becomes** urgent (not about
what already was when you signed in). Clicking a notification opens it in Ferret; several at once open this list.

Some things can be dealt with right here (if you can change things):

- **Maintenance → Done…**: when it was done (today unless you change it), a note and what it cost, and the counter's
  reading for [maintenance by use](./maintenance). The next due date moves on, as in Ferret.
- **A loan → Returned…**: it's back, or you gave it back, as of today.

Everything else opens where Ferret deals with it.

### Shopping list

When something you [keep count of](./stock) has run out or is running low, a cart appears along the top. **Bought**
adds what you bought to its count (it leaves the list once there are enough), with **Undo** in case of a slip;
right-click for **Bought 1**. **Copy List** copies the whole list for the shop.

### Ask Ferret

Ask about your things: where something is, what a manual says, when a warranty ends. The answer shows where it came
from; click a source to open it in Ferret. It's there when your Ferret has an [AI model](./ai) set up.

### Add

A name, a place and how many, plus any photos, receipts or manuals. Add files in any of these ways:

- **Drop them on the paw**: the Add screen opens with them.
- **Drop them on the Add screen**, or **Choose Files…**. While the Add screen is open, the window stays open when you
  click another app, so you can drag files over from Finder.
- **Drop them on a thing** in the search results: they're added to that thing.

Everything else about it is filled in in Ferret (**Open in Ferret** after adding).

Drag the window away from the menu bar to keep it open as a window of its own.

## Opening things in Ferret's web app

Things open in your browser, unless you've installed Ferret as an app with **Chrome**, **Edge** or **Brave** (**Install
Ferret** in the browser's menu, or the install button in its address bar). Then Ferret Menu can open them in that app
instead:

1. Open the installed Ferret app once, so it learns to open pages for other apps. If the browser asks whether Ferret
   may open **web+ferret** links, allow it.
2. In Ferret Menu's **Settings**, under **Open things in**, choose **Choose Web App…** and pick it (Chrome keeps its
   apps in **Chrome Apps**, in the **Applications** folder of your home folder).

Settings says when it's ready. Until then, or if the web app is for a different Ferret than the one Ferret Menu is
signed in to, things keep opening in your browser. Safari's web apps (**Add to Dock**) can't open pages for other
apps.

## Settings

Right-click the paw (or **⋯ → Settings…**):

- **Open at login**, and the shortcut that opens the window.
- **Notify me when something becomes urgent**. If macOS has notifications off for Ferret Menu, it says so, with a
  button to **System Settings**.
- Who it's signed in as, the household, and whether it **can change things**. **Sign Out…** ends this Mac's sign-in
  on the server too.
- **Updates**: Ferret Menu checks once a day and offers a new version in its window (or **⋯ → Check for Updates…**).
  **Install updates automatically** downloads them in the background and installs them the next time Ferret Menu quits
  or the Mac restarts. An update installs only when it's signed by Ferret Menu's own key.

## Troubleshooting

- **No paw in the menu bar?** On a Mac with a notch, a full menu bar hides the newest icons. **⌃⌥⌘F** still opens
  Ferret Menu from the middle of the menu bar; or make room by ⌘-dragging other icons out of the menu bar.
- **macOS asks whether Ferret Menu may use its Keychain item** after an update: choose **Always Allow**. Until Ferret
  Menu is signed by Apple, macOS treats each new version as a new app.
- **"Can't reach the server"**: what it shows is from the last time it could. It tries again every few minutes, when the
  window opens, and when your Mac wakes up.
- **Signed out by itself?** The app was disconnected in Ferret's **Connected apps**, or you left the household. Sign in
  again.
- **"The server sent the app to another address"**: Ferret Menu doesn't follow a server to a different address (it
  would take your sign-in along). Sign in with the address it names.

## Privacy

Ferret Menu talks only to your Ferret, and once a day asks GitHub whether there's a newer Ferret Menu (nothing about
you or your Ferret is sent; switch it off in **Settings**). The sign-in is kept in your Mac's Keychain. No analytics, no
crash reports.
