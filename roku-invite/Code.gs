/**
 * Eudaimonia TV — "Bring your film to Roku" landing page.
 *
 * Paste this file and Index.html into the Apps Script project of the
 * "Eudaimonia TV Roku Sign-ups" Google Sheet (Extensions > Apps Script),
 * then Deploy > New deployment > Web app (Execute as: Me, Access: Anyone).
 * Every sign-up becomes a row in the "Sign-ups" tab.
 */

// Eudaimonia-TV-nav-logo.png in your Drive. Read by the script as you, so it stays private.
var LOGO_FILE_ID = '1vbyQ0Ev8v9D7tD8TX68M5UZMlvFT3EIS';
var SHEET_NAME = 'Sign-ups';
// Set to false to stop the email you get for each new sign-up.
var NOTIFY_ON_SIGNUP = true;

var COLUMNS = [
  'Received', 'Name', 'Email', 'Film title', 'Runtime (min)', 'Film link', 'Link password',
  'FilmFreeway tracking #', 'Made with AI', 'Channels', 'Interested in', 'Synopsis',
  'Rights confirmed', 'Status', 'Team notes'
];

function doGet() {
  var page = HtmlService.createTemplateFromFile('Index');
  page.logoSrc = logoDataUri_();
  return page.evaluate()
    .setTitle('Bring Your Film to Roku · Eudaimonia TV')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function submitSignup(data) {
  data = data || {};
  if (data.website) return { ok: true }; // hidden field only bots fill in

  var d = {};
  ['name', 'email', 'title', 'runtime', 'link', 'password', 'tracking', 'ai', 'synopsis', 'channels', 'option', 'rights']
    .forEach(function (k) { d[k] = String(data[k] || '').trim().slice(0, 2000); });

  if (!d.name || !d.title) return { ok: false, error: 'Please add your name and film title.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return { ok: false, error: 'Please check your email address.' };
  if (!/^https?:\/\/\S+$/i.test(d.link)) return { ok: false, error: 'Please add a full link to watch your film.' };
  if (d.rights !== 'yes') return { ok: false, error: 'Please confirm you can share this film.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = signupSheet_();
    sheet.appendRow([
      new Date(), d.name, d.email, d.title, d.runtime, d.link, d.password, d.tracking, d.ai,
      d.channels, d.option, d.synopsis, 'Yes', 'New', ''
    ].map(safeCell_));
  } finally {
    lock.releaseLock();
  }

  if (NOTIFY_ON_SIGNUP) {
    try {
      MailApp.sendEmail({
        to: Session.getEffectiveUser().getEmail(),
        subject: 'New Roku sign-up: ' + d.title,
        body: d.name + ' (' + d.email + ') signed up "' + d.title + '".\n\n' +
          'Channels: ' + d.channels + '\nInterested in: ' + d.option + '\nMade with AI: ' + (d.ai || 'not said') +
          '\nLink: ' + d.link + '\n\nOpen the sheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
      });
    } catch (e) {
      // The sign-up is already saved; a failed notification shouldn't fail the form.
    }
  }
  return { ok: true };
}

function signupSheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  // This spreadsheet is only for sign-ups, so its first tab becomes "Sign-ups".
  var sheet = book.getSheetByName(SHEET_NAME) || book.getSheets()[0].setName(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

// Stops a value like "=IMPORTXML(...)" from running as a formula in the sheet.
function safeCell_(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
}

function logoDataUri_() {
  try {
    var blob = DriveApp.getFileById(LOGO_FILE_ID).getBlob();
    return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    return '';
  }
}
