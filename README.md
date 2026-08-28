# Where Do I Park? — UMD Parking Helper

An unofficial, community web app that turns UMD's scattered parking rules into a
simple answer: **"Where should I park today?"** Pick who you are, where you're
going, and when — it recommends the three best lots, with walking distance, cost,
and a map.

Works on desktop and mobile. 100% static — no backend, no build step. Hosts free
on GitHub Pages.

> ⚠️ **Unofficial and not affiliated with the University of Maryland or DOTS.**
> Always confirm against posted lot signs and the
> [official parking rules](https://transportation.umd.edu/parking).

---

## What it does

- **Visitors** → nearest visitor garages with the $4/hr ($20/day max) cost, plus a
  note about ParkMobile surface zones. Free before 7am / after midnight.
- **Students** → real DOTS assignments from the regulations:
  - *Commuter* lots by **class standing** (0–29 → Lots 6, 9, 11; 30+ → Lots 1, 6, 9, 11, SDG)
  - *Resident* lots by **housing area** (e.g. Fraternity Row → Lot 16; North Hill →
    Lots 2, 3, 6, and Lot 19 with 60+ credits)
  - *Overnight storage* → Lots 11, 17, 19
  - Plus lots that open free after 4pm / weekends, a 3–5am commuter-lot warning, and
    athletic/special-event relocation flags.
- **Faculty/Staff** (annual / daily / 2-day / 3-day) → your assigned lot + the overflow
  lots (K, P, U, V, X1, XX1, Z, Stadium Drive Garage, and any numbered lot except Lot 2).

Students and faculty/staff also get a pointer to the
[UMD parking portal](https://umd.aimsparking.com/) to buy/renew/manage permits (login
required — the app does not integrate with it).

Ranking factors: walking distance, cost, and whether the lot is legal at your
chosen day/time.

## Project layout

```
umd-parking/
├── index.html          # UI (4-step wizard + results)
├── css/style.css
├── js/app.js           # rules engine + map (Leaflet)
├── data/
│   ├── buildings.json  # 294 campus buildings + coordinates
│   ├── lots.json       # 124 lots/garages + coordinates + eligibility flags
│   └── build_data.py   # regenerates the two JSON files from UMD's public GIS
└── README.md
```

## Run locally

Because the app loads JSON with `fetch`, open it through a tiny web server (not
`file://`):

```bash
cd umd-parking
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy to GitHub Pages

```bash
cd umd-parking
git init
git add .
git commit -m "UMD parking helper"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Build and deployment → Source: Deploy from
a branch → `main` / `root`**. Your site goes live at
`https://<you>.github.io/<repo>/` within a minute or two. No other config needed.

## Refreshing the data

Lot codes, buildings, and rates change (usually each academic year). To pull fresh
coordinates from UMD's public GIS services:

```bash
cd data
python3 build_data.py   # standard library only; rewrites buildings.json + lots.json
```

Rates and rule text (the `$4/hr`, the after-4pm windows, the overflow lot list)
are encoded in `js/app.js` and the flags in `build_data.py` — update those if DOTS
changes the rules. Sources used:

- Rules & rates: <https://transportation.umd.edu/parking> (faculty-staff, students,
  visitors sub-pages, and the regulations PDF)
- Buildings: MD iMap `MD_CampusFacilities` service, UMD Buildings layer
- Lots & garages: UMD DOTS `CampusMapDefault_NoInsite` feature service

## Rule fidelity (v2)

Student and faculty/staff assignments, overflow lists, the 3–5am commuter rule, the
athletic-relocation lots, visitor rates, and garage aliases (Lot 6 = Terrapin Trail,
Lot 19 = Mowatt, SDG = Stadium Drive) are all transcribed from the DOTS **Parking
Regulations** PDF (2025-26 edition) and the DOTS web pages. Update them in `js/app.js`
when a new edition drops.

## Known limitations

- **Red-text / individually-signed restrictions** beyond those above aren't encoded —
  the app always tells the user to check the sign, which overrides any suggestion.
- Distances are straight-line, not walking routes.
- A **faculty/staff** member's assigned lot is entered by the user (UMD doesn't publish
  individual TSC assignments). Student assignments are derived from class standing /
  housing per the regulations.
- Visitor surface-lot eligibility varies by lot; the app recommends garages (always
  visitor-open) and notes ParkMobile surface zones.
- Lots 5 and 7 appear in the regulations' athletic list but aren't in UMD's public GIS
  point layer, so they can't be mapped.
