# Handoff: Roku sign-up site (Nov 2, 2026)

Pick up from here in a desktop session that can reach ComfyUI.

## Goal
A public landing page inviting The Eudaimonia Project Film Festival filmmakers
to put their films on the Roku channels, with good-looking graphics. Then
send targeted invites through FilmFreeway's own message tool.

## Done
- `roku-invite/Index.html` + `Code.gs`: finished, tested page design (brand
  navy/blue/gold, Montserrat + Lato, logo from Drive). This is the approved
  design. EU TV is the only channel marked live; all others say "Coming soon".
- Google Sheet **Eudaimonia TV Roku Sign-ups** in Drive
  (id `1WgujlVkbMn_IUEiALTyc94_3bl4nkV7zwUehR2wCFh4`), header row only.
- Higgsfield website created, nothing deployed yet:
  id `b49501f2-1e8f-414e-8c06-f9654d545f43`, subdomain `eudaimonia-roku`.

## Decisions Emmanuel made
- Standard page (no scroll animation). Do not list it on Higgsfield's
  community feed.
- Sign-ups save in the site's own database (D1); copy them into the Google
  Sheet when asked.
- Offer: free exposure on Roku; to earn money, add the film to Vimeo OTT at
  watch.eudaimoniatv.com. No revenue share has been stated, so never invent one.
- Invites go out through FilmFreeway's "message submitters" tool, filtered by
  category. Sign as Emmanuel Simms.
- Make graphics with ComfyUI at http://127.0.0.1:8188 (Tailscale
  100.93.186.16:8188) on Emmanuel's machine.

## Next steps
1. Make graphics on ComfyUI: hero art for the page, one card image per
   channel, a 1200x630 share image, and a social post promoting the page.
2. Port Index.html into the Higgsfield site (React route + `/api/signup`
   writing to D1; set `"db": true` in `app.manifest.json`; fill
   `app/src/app-meta.json`; remove Higgsfield/Quanta branding from the root
   route), then deploy.
3. Put the live link into the FilmFreeway messages and send Emmanuel the
   final text for each category.

## Channels (from Emmanuel)
- **Live:** EU TV, the wellness network (Roku code VKVJ5D9, add link
  https://my.roku.com/account/add/VKVJ5D9). On the TV, search "Eudaimonia"
  and pick EU TV, because the new Eudaimonia TV channel also appears in that
  search.
- **Not up yet:** Tusk TV (the flagship), Indie Movie Network, Eudaimonia TV
  (lifestyle), OTTV Plus +, Freestyle & Laughs, In Vivo Exposure, OTTV Kids
  (kid-safe only), Synth TV (AI films, labeled "Made with AI").
- **Not taking submissions:** OverTyme Simms TV Plus, Simms Classic Movies.
- **Support contact:** ceo@theinvivoexposure.com, 240-501-3850.

## Which channel each FilmFreeway category is invited to
- Blackwell AI Award → Synth TV (coming soon)
- Dr. Chester Pierce Award → EU TV (live) and In Vivo Exposure
- Creative Music Video → OTTV Plus +
- Everything else → EU TV now, and Indie Movie Network when it launches

## Still to confirm with Emmanuel
- That a reviewer will actually watch each film ("Our team reviews your
  film" is on the page).
- What filmmakers earn on Vimeo OTT, before anyone asks.
- Whether to send before or after the Nov 5 notification date.
