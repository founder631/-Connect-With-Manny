# -Connect-With-Manny

## Festival Hub (The Eudaimonia Project Film Festival)

`festival-hub/` is a private dashboard for your FilmFreeway submissions. It runs on
your own computer and talks to the FilmFreeway Submissions API for you.

**What it does**

- **Overview:** live countdowns to season close and notification day. Totals for
  entries, fee revenue, paid vs free, viewing hours, countries, first-time and
  student filmmakers, AI-made films and DCPs. Charts for submissions over time,
  categories, deadlines, countries, genres, runtimes, languages and revenue by
  category. Click any bar to jump to those films.
- **Submissions:** search, filter (category, deadline, country, genre, status,
  AI, decision, student, first-time, trailer, runtime) and sort every entry.
  Click a film to open a side panel with the synopsis, cover letter, statement,
  credits, laurels, an embedded trailer and the poster/stills.
- **Judging:** rate 1–5 stars, mark Yes / Maybe / No, shortlist and keep team
  notes for each film. Keyboard shortcuts: `j`/`k` next/previous, `1`–`5` rate,
  `y`/`m`/`n` decide, `s` shortlist, `/` search.
- **Shortlist & Programme:** drag shortlisted films into screening blocks, each
  with a target length. A meter shows when a block runs over.
- **Insights:** repeat submitters, duplicate titles, runtimes that don't fit
  their category, missing synopsis or trailer, films with festival laurels, and
  discount-code usage.
- **Exports:** CSV of filtered, all or shortlisted films (with your notes); a
  programme schedule CSV; printable Official Selections and Programme pages
  (save as PDF); and a backup and restore of your workspace.

### Run it

You need Python 3, which is already on most Macs. Nothing else needs installing.

1. In the `festival-hub` folder, create a file named `.env` containing:

   ```
   FILMFREEWAY_API_KEY=paste-your-key-here
   ```

   `.env` is git-ignored, so your key never gets committed.

2. Start it:

   ```
   python3 festival-hub/hub.py
   ```

   Your browser opens at <http://127.0.0.1:8787>. Press **↻ Refresh** any time
   to pull the latest submissions.

**Other ways to run it**

- `python3 festival-hub/hub.py --demo` shows the dashboard with made-up films.
  It needs no key.
- `python3 festival-hub/hub.py sync` downloads every submission to
  `festival-hub/data/submissions.json` and `submissions.csv`.

### Notes

- **Where your data lives:** everything is kept in `festival-hub/data/`. That
  includes the downloaded submissions plus your ratings, decisions, notes,
  shortlist and blocks (`workspace.json`). The folder is git-ignored.
  FilmFreeway's API terms allow this data only for running your own festival,
  so don't share it publicly.
- **Your key stays private:** the server listens only on your own computer
  (127.0.0.1). The key never reaches the browser.
- **Judging columns:** FilmFreeway's own ratings, judge assignments and
  acceptance status appear automatically when your API key has the
  `submissions:judging_data` scope. The header badges show which scopes your
  key has.
- **AI-made badges are a guess:** a film is flagged "AI-made" when its synopsis,
  cover letter or format mentions AI tools such as Runway, Sora, Midjourney or
  ElevenLabs, or says "AI-generated". Films that only talk about AI are marked
  "about AI". Check before you rely on it.
