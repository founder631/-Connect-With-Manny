# Bring Your Film to Roku: landing page

This is the sign-up page that invites filmmakers to put their films on the
Eudaimonia TV Roku channels. Every sign-up is saved as a row in the
**Eudaimonia TV Roku Sign-ups** Google Sheet in Drive, and you get an email
for each one.

The page runs as a Google Apps Script web app attached to that Sheet. It needs
no other hosting.

## Put it live (about 5 minutes)

1. Open the **Eudaimonia TV Roku Sign-ups** Sheet in Google Drive.
2. Choose **Extensions → Apps Script**.
3. Paste everything from `Code.gs` over the starter code in the editor.
4. Click **+** next to **Files**, choose **HTML** and name it `Index`. Paste
   everything from `Index.html` into it.
5. Click **Save**, then **Deploy → New deployment**. Click the gear and pick
   **Web app**. Set **Execute as: Me** and **Who has access: Anyone**, then click
   **Deploy**.
6. Google asks you to authorize the script. It needs this to save sign-ups to
   the Sheet, read the logo from Drive and email you. Because it's your own
   script, Google may show "Google hasn't verified this app". Choose
   **Advanced → Go to (project name)** and then **Allow**.
7. Copy the **Web app URL**. That's the link to put in the FilmFreeway messages
   and on your website.

**To change the page later:** edit the files, then go to **Deploy → Manage
deployments → Edit (pencil) → Version: New version → Deploy**. The link stays
the same.

## What it collects

Name, email, film title, runtime, a link to watch the film (and its password),
FilmFreeway tracking number, whether AI was used, a synopsis, which channels
fit, and whether they want free Roku exposure only or also want to earn on
watch.eudaimoniatv.com. The **Status** and **Team notes** columns are for your
team to fill in.

## Settings in `Code.gs`

- `NOTIFY_ON_SIGNUP`: set to `false` to stop the email you get for each
  sign-up.
- `LOGO_FILE_ID`: the Drive file used as the logo (`Eudaimonia-TV-nav-logo.png`).
  The script reads it as you, so the logo file stays private.
