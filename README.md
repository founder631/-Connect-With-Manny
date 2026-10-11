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

## OverTyme Studio (ComfyUI One Image Packs)

`overtyme-studio/` is a web page that runs the 16 OverTyme one-image workflows
(Creative Mad Scientist and Lemonade & Patron) on your own ComfyUI. Clients
use the page and never see the node graph or a terminal.

**What the client sees**

1. **Your photo:** drag in a JPG, PNG or WebP. If a `reference.png` sits in
   the folder, it is used by default.
2. **Choose a scene:** tabs for the two packs, with a card for each of the 8 scenes.
3. **Frame & generate:** portrait (768 × 1024) or widescreen (1280 × 720),
   then **Generate photo**.

While it works, a live panel shows the status and a timer. When it is done,
the photo appears with **Download** and **Make another** (a fresh variation).
Every finished photo stays in a **Your photos** gallery. A badge shows whether
ComfyUI is ready, busy or offline.

### Run it

**Double-click start (DGX Spark / Linux desktop)**

Run this once in a terminal:

```
overtyme-studio/start-studio.sh --install
```

It adds an **OverTyme Studio** icon to your Desktop and app menu. If the
Desktop icon shows a warning the first time, right-click it and choose
**Allow Launching**. From then on, double-click the icon. It does three things:

- Starts ComfyUI if it isn't running yet. For this, add the folder you
  installed ComfyUI in to `overtyme-studio/.env`, for example
  `COMFYUI_DIR=/home/you/ComfyUI`. It uses that folder's `venv` or `.venv`
  if there is one.
- Starts the studio and opens it in your browser. Keep the terminal window
  open while you work, and close it to stop the studio. ComfyUI keeps
  running.
- If the studio is already running, it just opens the page again.

`overtyme-studio/.env` can also hold `STUDIO_ENGINE=router` (make photos on
Comfy Router) and `STUDIO_SHARE=1` (let devices on your Wi-Fi open it). See
`.env.example`.

**Or start it by hand.** Start ComfyUI first (it should be at
<http://127.0.0.1:8188>), then:

```
python3 overtyme-studio/studio.py
```

Your browser opens at <http://127.0.0.1:8790>.

- `--share` lets a client on the same Wi-Fi open it from their phone or laptop.
  It prints the address to give them. There is no password, so only use this
  on a network you trust.
- `--comfy http://host:port` points it at a ComfyUI running somewhere else.
- `python3 overtyme-studio/generate.py` still works as the terminal launcher.

### Make studio photos on Comfy Router

Instead of your Spark, the studio can send each photo to
[Comfy Router](https://docs.comfy.org/development/comfy-router/quickstart):

1. Copy `overtyme-studio/.env.example` to `overtyme-studio/.env` and fill in
   `COMFY_API_KEY`.
2. Start it with:

   ```
   python3 overtyme-studio/studio.py --engine router
   ```

   It uses `qwen/qwen-image-3.0-pro` by default. Pick another model with
   `--model provider/model`.

When it starts, the studio reads the model's live schema and prints where each
input goes, for example `prompt → prompt, photo → images[0], size → nearest
size option`. Each scene's own prompt and negative prompt are sent with the
client's photo. Portrait and widescreen pick the closest size the model
offers. If the model has no prompt or photo input, or needs an input the
studio can't fill, it stops and says so instead of sending a bad request.

Notes for Router mode:

- The client's photo is sent to Comfy to make each image, and the page footer
  says so.
- Each photo is a queued Router request with its own `Idempotency-Key`. If you
  restart the studio, unfinished photos carry on and are never sent twice.
- Each person only sees their own photos, including when you use `--share`.
- Each photo uses Comfy credits.
- Without `--engine router`, the studio uses your local ComfyUI exactly as
  before.

### Comfy Router test console

Open <http://127.0.0.1:8790/router> (also linked at the bottom of the studio)
to try models on [Comfy Router](https://docs.comfy.org/development/comfy-router/quickstart)
before the studio switches over to it.

1. Copy `overtyme-studio/.env.example` to `overtyme-studio/.env` and fill in
   `COMFY_API_KEY`. The key is only read by the local server. It is never sent
   to the browser and `.env` is git-ignored.
2. Start the studio as usual. The console loads `qwen/qwen-image-3.0-pro` by
   default. Type any `provider/model` and press **Load schema** to try another.
3. The form is built from the model's live schema
   (`https://api.comfy.org/v2/models/{provider}/{model}/openapi.json`). Photos
   are sent as base64 data URIs. **Request body (JSON)** lets you send anything
   the form doesn't cover.
4. **Send to Router** queues the request
   (`POST /v2/models/{provider}/{model}/requests`) with a fresh
   `Idempotency-Key`. Then it follows the status route, honouring `Retry-After`,
   until the status is `COMPLETED`, and downloads the result straight away
   because Router links expire. On 409, 429 or 504 it retries with the same
   key, so nothing runs or is charged twice. A 422 shows which input was
   wrong.
5. Each request shows its `request_id`, its result and every Router response.
   Requests are tied to your browser, so other people on `--share` can't see
   them. Results are saved in `overtyme-studio/Results/router/`.

Each successful request uses Comfy credits.

### Notes

- It makes one photo at a time. If ComfyUI is already busy, the page says so
  and does not add another job.
- Finished photos, along with the photo each one was made from, are saved in
  `overtyme-studio/Results/`. That folder and any `reference.*` photo are
  git-ignored, so client photos are never committed.
- The original models, LoRAs, prompts and 40-step quality settings are kept.
  Each run gets a new random seed.
