"""Made-up submissions for trying Festival Hub without an API key.

Every title, name and number here is invented. Nothing comes from FilmFreeway.
The shape matches the FilmFreeway Submissions API v1 so the dashboard behaves
exactly as it will with real data.
"""

import random
import time
from datetime import datetime, timedelta

CATEGORIES = [
    (1799670, "Brain Baby Need Love Too  (Free Submission) ", "$0.00"),
    (1799672, " Short Film (Under 40 Minutes)", "$25.00"),
    (1799676, "Documentary Short (Under 40 Minutes)", "$25.00"),
    (1799677, "Documentary Feature (40 Minutes & Over)", "$40.00"),
    (1799671, "Emerging Filmmaker Category", "$15.00"),
    (1799673, "The David Harold Blackwell Award for AI & Emerging Technology Film", "$20.00"),
    (1799674, "\U0001f3c6 BEST PERFORMANCE — Individual Recognition", "$15.00"),
    (1799678, "Student Film", "$10.00"),
    (1799679, "The Dr. Chester Pierce Award for Mental Health & Wellness Film", "$20.00"),
    (1799680, "Animated Short (Under 40 Minutes)", "$25.00"),
    (1813148, "Creative Music Video", "$15.00"),
    (1813151, "Animated Feature (40 Minutes & Over)", "$40.00"),
    (1813152, "The Bill Gunn Award for Experimental Film", "$20.00"),
]
DEADLINES = ["Earlybird Deadline", "Regular Deadline", "Late Deadline", "Extended Deadline"]
COUNTRIES = [
    ("United States", "US"), ("United Kingdom", "GB"), ("Nigeria", "NG"), ("India", "IN"),
    ("Brazil", "BR"), ("Canada", "CA"), ("France", "FR"), ("Iran", "IR"), ("Spain", "ES"),
    ("South Africa", "ZA"), ("Japan", "JP"), ("Mexico", "MX"), ("Germany", "DE"), ("Ghana", "GH"),
    ("Italy", "IT"), ("Turkey", "TR"), ("Australia", "AU"), ("Kenya", "KE"),
]
GENRES = ["Drama", "Comedy", "Experimental", "Sci-Fi", "Horror", "Thriller", "Social Issue",
          "Coming of Age", "Fantasy", "Romance", "Family", "Music", "Biography"]
LANGUAGES = ["English", "Spanish", "French", "Portuguese", "Hindi", "Yoruba", "Persian",
             "Japanese", "German", "Italian", "Turkish", "Swahili", "No Dialogue"]
TYPES = {
    "Short Film (Under 40 Minutes)": ["Short"],
    "Documentary": ["Documentary", "Short"],
    "Documentary Feature": ["Documentary", "Feature"],
    "Animated": ["Animation", "Short"],
    "Animated Feature": ["Animation", "Feature"],
    "Music Video": ["Music Video"],
    "Experimental": ["Experimental", "Short"],
}
FIRST = ["Amara", "Jonah", "Leila", "Mateo", "Priya", "Kwame", "Sofia", "Darius", "Yuki",
         "Chidi", "Elena", "Marcus", "Nadia", "Tomas", "Zainab", "Rafael", "Imani", "Arjun",
         "Hana", "Olu", "Camille", "Theo", "Ines", "Bilal"]
LAST = ["Okafor", "Reyes", "Haddad", "Sato", "Mensah", "Varga", "Patel", "Moreau", "Silva",
        "Adeyemi", "Kowalski", "Nakamura", "Rahimi", "Ortega", "Brooks", "Lindqvist", "Diallo",
        "Ferreira", "Ito", "Baptiste"]
WORDS_A = ["Quiet", "Electric", "Last", "Paper", "Hollow", "Golden", "Broken", "Midnight",
           "Small", "Distant", "Borrowed", "Silver", "Wild", "Second", "Salt", "Glass"]
WORDS_B = ["River", "Machine", "Mother", "Signal", "Harvest", "Kingdom", "Weather", "Garden",
           "Frequency", "Daughter", "Hours", "Ghosts", "Light", "Season", "Orbit", "Tide"]
SYNOPSES = [
    "A {who} returns home after ten years and finds the house exactly as {pron} left it - except for one locked door.",
    "When the power fails across the city, a {who} and a stranger share one night that changes both of them.",
    "A {who} spends a final summer recording the stories of a disappearing neighbourhood.",
    "An intimate portrait of a {who} learning to live with grief, told through letters never sent.",
    "A {who} discovers that the voice on the late-night radio knows things no one should know.",
    "Over a single dinner, a family's careful silence finally breaks.",
    "A {who} trains for the race that everyone says is impossible.",
    "Through hand-drawn animation, a {who} walks through memory to find the moment everything changed.",
]
WHO = ["young nurse", "retired boxer", "teenage poet", "night-shift cleaner", "widowed farmer",
       "street musician", "single father", "museum guard", "former astronaut", "child refugee"]
AI_NOTES = [
    "Visuals generated with Runway Gen-3 and Midjourney; voice by ElevenLabs.",
    "This is an AI-assisted film made with Sora and Kling.",
    "Created using generative AI tools (AIGC) alongside traditional editing.",
]
FESTIVALS = ["Lagos Shorts Week", "Northern Lights Film Fest", "Riverbend Indie Fest",
             "Coastal Cinema Days", "Open Frame Festival", "Midnight Reel Showcase"]


def _duration(minutes):
    seconds = int(minutes * 60)
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _person(rng):
    first, last = rng.choice(FIRST), rng.choice(LAST)
    return {"name": f"{first} {last}", "first_name": first, "last_name": last,
            "character_name": None, "prior_credits": None}


def build_demo_payload(count=420, seed=96638):
    rng = random.Random(seed)
    season_start = datetime(2026, 1, 15)
    submissions = []
    repeat_directors = [_person(rng) for _ in range(5)]

    for index in range(count):
        cat_id, cat_name, fee = rng.choices(CATEGORIES, weights=[14, 22, 9, 4, 8, 10, 4, 7, 6, 6, 5, 2, 5])[0]
        clean = cat_name.strip()
        is_feature = "Feature" in clean
        if "Music Video" in clean:
            minutes = rng.uniform(2.5, 6)
        elif is_feature:
            minutes = rng.uniform(42, 118)
        else:
            minutes = rng.triangular(1.5, 39, 11)
        country, code = rng.choice(COUNTRIES)
        director = rng.choice(repeat_directors) if rng.random() < 0.08 else _person(rng)
        title = f"{rng.choice(WORDS_A)} {rng.choice(WORDS_B)}"
        if rng.random() < 0.15:
            title = "The " + title
        ai_made = "AI" in clean or rng.random() < 0.18
        created = season_start + timedelta(days=rng.triangular(0, 265, 230), hours=rng.uniform(0, 23))
        deadline = DEADLINES[min(3, int((created - season_start).days / 70))]
        waived = rng.random() < 0.1
        discount = {"code": "EUDAIMONIA50", "optional_label": "Community", "amount": "50%"} if rng.random() < 0.07 else None
        pron = rng.choice(["she", "he", "they"])
        synopsis = rng.choice(SYNOPSES).format(who=rng.choice(WHO), pron=pron)
        if ai_made:
            synopsis += " " + rng.choice(AI_NOTES)
        type_key = next((k for k in TYPES if k.split(" (")[0] in clean), "Short Film (Under 40 Minutes)")
        project_categories = TYPES.get(type_key, ["Short"])
        has_trailer = rng.random() < 0.55
        screenings = []
        for _ in range(rng.choice([0, 0, 0, 1, 1, 2, 3])):
            screenings.append({
                "event_name": rng.choice(FESTIVALS), "location": rng.choice(COUNTRIES)[0],
                "date": f"2026-0{rng.randint(1, 9)}-{rng.randint(10, 28)}",
                "premiere_status": rng.choice(["World Premiere", "None", "National Premiere"]),
                "awards_won": rng.choice(["", "", "Official Selection", "Best Short", "Audience Award"]),
                "country": rng.choice(COUNTRIES)[1],
            })
        cast = [dict(_person(rng), character_name=rng.choice(WHO).title()) for _ in range(rng.randint(1, 4))]
        status = rng.choices(["Undecided", "Disqualified", "Withdrawn"], weights=[95, 2, 3])[0]

        submissions.append({
            "id": 31000000 + index * 37,
            "tracking_number": f"DEMO-{index + 1:04d}",
            "festival_id": 0,
            "notification_date": "2026-10-17",
            "cover_letter": rng.choice(["", "", "Thank you for considering our film - it means a lot to our whole team."]),
            "custom_fields": [],
            "season": {"name": "2026 (demo)"},
            "created_at": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "submission_status": status,
            "submission_deadlines": [deadline],
            "submission_categories": [cat_name],
            "festival_category_ids": [cat_id],
            "submission_fee": "$0.00" if waived else fee,
            "discount_code": discount,
            "project": {
                "title": title,
                "synopsis": synopsis,
                "duration": _duration(minutes),
                "student_project": "Student" in clean or rng.random() < 0.08,
                "first_time_filmmaker": "Emerging" in clean or rng.random() < 0.3,
                "completion_date": f"202{rng.randint(4, 6)}-0{rng.randint(1, 9)}-15",
                "budget": rng.choice([None, "$500", "$2,000", "$15,000", "$80,000"]),
                "credits": [
                    {"type": "Director", "entries": [director]},
                    {"type": "Writers", "entries": [rng.choice([director, _person(rng)])]},
                    {"type": "Producers", "entries": [_person(rng)]},
                    {"type": "Key Cast", "entries": cast},
                ],
                "screenings": screenings,
                "countries_of_origin": {"names": [country], "codes": [code]},
                "country_name": country,
                "genres": rng.sample(GENRES, rng.randint(1, 3)),
                "languages": rng.sample(LANGUAGES, 1 if rng.random() < 0.8 else 2),
                "project_categories": project_categories,
                "shooting_format": "AI Generated" if ai_made and rng.random() < 0.4 else rng.choice(["Digital", "16mm", "iPhone", "Digital"]),
                "aspect_ratio": rng.choice(["16:9", "2.39:1", "1.85:1", "4:3", "9:16"]),
                "film_color": rng.choice(["Color", "Color", "Black & White"]),
                "press_kit_statement": "Director's statement (demo text).",
                "press_kit_biography": f"{director['name']} is an invented demo filmmaker.",
                "press_kit_trailer_url": "https://vimeo.com/76979871" if has_trailer else "",
                "digital_copy_url": "",
                "dcp_available": rng.random() < 0.12,
            },
        })

    submissions.sort(key=lambda s: s["created_at"], reverse=True)
    return {
        "submissions": submissions,
        "meta": {
            "count": len(submissions),
            "total_count": len(submissions),
            "granted_scopes": [],
            "season_status": "open",
            "season_end_date": "2026-10-31",
        },
        "synced_at": time.time(),
        "demo": True,
    }
