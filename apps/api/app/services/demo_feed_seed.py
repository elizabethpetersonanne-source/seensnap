from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
import os
import random

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.content import ContentTitle
from app.models.social import (
    FeedComment,
    FeedEvent,
    FeedReaction,
    Team,
    TeamActivity,
    TeamMember,
    TeamRanking,
    TeamTitle,
    UserFollow,
    Watchlist,
    WatchlistItem,
)
from app.models.taste import TeamAnalyticsSnapshot
from app.models.user import User, UserPreferences, UserProfile
from app.services.demo import DEMO_EMAIL
from app.services.feed import create_feed_event
from app.services.follows import ensure_follows_table
from app.services.tmdb import search_titles as tmdb_search_titles, refresh_title_details
from app.services.watchlists import ensure_default_watchlists
from app.services.wikipedia import resolve_wikipedia_metadata

SEED_TAG = "demo_feed_v5"
MEDIA_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
LOGO_AVATAR_URL = "/media/brand/seensnap_logo.png"
SCENESNAP_ACCOUNT_CODES = {"platform_trending", "industry_news", "u_demo"}

def _dicebear(seed: str) -> str:
    return f"https://api.dicebear.com/7.x/avataaars/png?seed={seed}&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf&size=150"

DEMO_USERS = [
    {"code": "u1",  "name": "Maya Chen",       "username": "framebyframe",     "bio": "Slow cinema. Long takes. Emotional damage.",                   "avatar": _dicebear("framebyframe")},
    {"code": "u2",  "name": "Jordan Alvarez",  "username": "prestigepilled",   "bio": "If it wins awards, I’m watching.",                             "avatar": _dicebear("prestigepilled")},
    {"code": "u3",  "name": "Sofia Romano",    "username": "comfortrewatcher", "bio": "Rotating comfort shows forever.",                              "avatar": _dicebear("comfortrewatcher")},
    {"code": "u4",  "name": "Evan Brooks",     "username": "cinematographyguy","bio": "Directors matter. Cinematography matters more.",                "avatar": _dicebear("cinematographyguy")},
    {"code": "u5",  "name": "Leila Haddad",    "username": "horrorhead",       "bio": "If it’s disturbing, I’ve seen it twice.",                      "avatar": _dicebear("horrorhead")},
    {"code": "u6",  "name": "Noah Greene",     "username": "letterboxdcore",   "bio": "Logging everything. Rewatching half.",                         "avatar": _dicebear("letterboxdcore")},
    {"code": "u7",  "name": "Chloe Park",      "username": "softspotlight",    "bio": "Messy women & moody lighting.",                                "avatar": _dicebear("softspotlight")},
    {"code": "u8",  "name": "Marcus Reed",     "username": "plotarmorgone",    "bio": "Good writing or I’m out.",                                     "avatar": _dicebear("plotarmorgone")},
    {"code": "u9",  "name": "Tessa Morgan",    "username": "rewindculture",    "bio": "90s kid. Rewatch specialist.",                                 "avatar": _dicebear("rewindculture")},
    {"code": "u10", "name": "Aiden Clarke",    "username": "blockbusterbrain", "bio": "Big screen. Big feelings.",                                    "avatar": _dicebear("blockbusterbrain")},
    {"code": "v1",  "name": "Lena Hart",       "username": "LenaHartOfficial", "bio": "Actor. Producer.",                                             "avatar": _dicebear("LenaHartOfficial"),   "verified": True},
    {"code": "v2",  "name": "Diego Valez",     "username": "DiegoValez",       "bio": "Director.",                                                    "avatar": _dicebear("DiegoValez"),         "verified": True},
    {"code": "v3",  "name": "Rae Kim",         "username": "RaeKimStudio",     "bio": "Writer & Showrunner.",                                         "avatar": _dicebear("RaeKimStudio"),       "verified": True},
    {"code": "v4",  "name": "Northlight Films","username": "NorthlightFilms",  "bio": "Independent studio.",                                          "avatar": _dicebear("NorthlightFilms"),    "verified": True},
    {"code": "platform_trending", "name": "Scene Snap Trending", "username": "seensnap_trending", "bio": "What the platform is watching right now.", "avatar": LOGO_AVATAR_URL, "verified": True},
    {"code": "industry_news", "name": "Scene Snap Industry", "username": "industry_news", "bio": "Industry updates and release radar.", "avatar": LOGO_AVATAR_URL},
    {"code": "u_demo", "name": "SeenSnap Demo", "username": "seensnap.demo", "bio": "Official SeenSnap demo account.", "avatar": LOGO_AVATAR_URL},
]

FOLLOWING_SEED = ["u1", "u2", "u4", "u7", "u8"]

WATCHLIST_SEED = {
    "My Picks": [
        "Past Lives",
        "The Bear",
        "Severance",
        "Portrait of a Lady on Fire",
        "Succession",
        "Fleabag",
        "Aftersun",
        "Arrival",
        "The Last of Us",
        "Midsommar",
        "Her",
        "The Social Network",
    ],
    "Want to Watch": [
        "Challengers",
        "Poor Things",
        "Anatomy of a Fall",
        "Dune: Part Two",
        "Saltburn",
        "Oppenheimer",
        "Everything Everywhere All At Once",
        "Blade Runner 2049",
        "True Detective S1",
        "Mindhunter",
    ],
    "Favorites": [
        "Moonlight",
        "Parasite",
        "Whiplash",
        "The Godfather",
        "Mad Men",
        "Breaking Bad",
        "Interstellar",
        "Hereditary",
        "Get Out",
        "Roma",
        "Lost in Translation",
        "Before Sunrise",
    ],
}

WATCH_TEAM_SEED = [
    {
        "name": "Prestige Spiral",
        "slug": "demo-prestige-spiral",
        "description": "High-stakes TV, auteur flexes, and dramatic overthinking.",
        "invite_code": "spiral24",
        "icon": "TV",
        "members": ["u_demo", "u1", "u2", "u4", "u8"],
        "titles": [
            {"title": "Succession", "added_by": "u2", "note": "Nobody does power games better.", "rank": 1, "score": 9.8, "movement": "same", "weeks_on_list": 6},
            {"title": "Severance", "added_by": "u8", "note": "Office dread but make it transcendent.", "rank": 2, "score": 9.4, "movement": "up", "weeks_on_list": 4},
            {"title": "The Bear", "added_by": "u_demo", "note": "Stress television at its absolute peak.", "rank": 3, "score": 9.1, "movement": "up", "weeks_on_list": 3},
        ],
        "posts": [
            {"author": "u_demo", "title": "Severance", "caption": "Need a full group watch when season two lands.", "likes": 148, "comments": ["I am so ready.", "Theories only get stranger.", "Count me in."]},
            {"author": "u4", "title": "The Bear", "caption": "Rewatched Forks and it somehow got better.", "likes": 97, "comments": ["Best episode in the series.", "Ebon Moss-Bachrach was unreal."]},
        ],
    },
    {
        "name": "After Hours",
        "slug": "demo-after-hours",
        "description": "Horror, arthouse heartbreak, and immaculate vibes.",
        "invite_code": "afterhrs",
        "icon": "MOON",
        "members": ["u_demo", "u5", "u6", "u7", "u9"],
        "titles": [
            {"title": "Midsommar", "added_by": "u5", "note": "Sunlit panic spiral cinema.", "rank": 1, "score": 9.2, "movement": "same", "weeks_on_list": 5},
            {"title": "Aftersun", "added_by": "u6", "note": "Emotionally unsafe in the best way.", "rank": 2, "score": 9.0, "movement": "up", "weeks_on_list": 4},
            {"title": "Portrait of a Lady on Fire", "added_by": "u7", "note": "Every frame hurts beautifully.", "rank": 3, "score": 8.9, "movement": "down", "weeks_on_list": 6},
        ],
        "posts": [
            {"author": "u5", "title": "Midsommar", "caption": "This team was built for daylight horror discourse.", "likes": 132, "comments": ["Absolutely cursed.", "Still thinking about the flower dress."]},
            {"author": "u7", "title": "Portrait of a Lady on Fire", "caption": "Can we talk about that final scene again or is it too soon?", "likes": 121, "comments": ["Never too soon.", "I still haven’t recovered.", "The score destroys me."]},
        ],
    },
    {
        "name": "Sci-Fi Syndicate",
        "slug": "demo-scifi-syndicate",
        "description": "Interstellar travel, dystopian dread, and debating Villeneuve at 2am.",
        "invite_code": "scifi42",
        "icon": "🚀",
        "members": ["u_demo", "u4", "u8", "u10", "u6"],
        "titles": [
            {"title": "Blade Runner 2049", "added_by": "u4", "note": "Deakins basically invented a new visual language.", "rank": 1, "score": 9.7, "movement": "same", "weeks_on_list": 8},
            {"title": "Interstellar", "added_by": "u10", "note": "The docking sequence is still the most intense 10 minutes in cinema.", "rank": 2, "score": 9.3, "movement": "up", "weeks_on_list": 6},
            {"title": "Dune: Part Two", "added_by": "u_demo", "note": "Villeneuve finally delivered the impossible adaptation.", "rank": 3, "score": 9.1, "movement": "up", "weeks_on_list": 5},
            {"title": "Arrival", "added_by": "u6", "note": "Time and language as one idea. Nothing else does this.", "rank": 4, "score": 9.0, "movement": "down", "weeks_on_list": 7},
        ],
        "posts": [
            {"author": "u4", "title": "Blade Runner 2049", "caption": "Every time I rewatch this I catch a new Deakins detail. Frame-by-frame filmmaking.", "likes": 203, "comments": ["The protein farm sequence is haunting.", "Shot selection is insane.", "No other cinematographer comes close."]},
            {"author": "u10", "title": "Dune: Part Two", "caption": "The sandworm ride scene in IMAX was the closest I’ve ever felt to being inside a film.", "likes": 181, "comments": ["IMAX was mandatory.", "Hans Zimmer going feral again.", "Zendaya barely speaks and still owns every scene."]},
            {"author": "u8", "title": "Arrival", "caption": "If you didn’t cry at the ending you didn’t understand the ending.", "likes": 144, "comments": ["The linguistic theory was so well researched.", "Amy Adams underrated performance.", "That twist recontextualizes everything."]},
        ],
    },
    {
        "name": "Comfort Rewatch Club",
        "slug": "demo-comfort-rewatch",
        "description": "No prestige guilt. Just comfort, cozy rewatches, and seasonal TV rotations.",
        "invite_code": "cozy99",
        "icon": "🛋️",
        "members": ["u_demo", "u3", "u9", "u7", "u1"],
        "titles": [
            {"title": "Ted Lasso", "added_by": "u3", "note": "The antidote to every cynical show. Watch it when the world is too much.", "rank": 1, "score": 9.0, "movement": "same", "weeks_on_list": 10},
            {"title": "Gilmore Girls", "added_by": "u9", "note": "Fall rewatch is non-negotiable.", "rank": 2, "score": 8.8, "movement": "up", "weeks_on_list": 8},
            {"title": "The Office", "added_by": "u_demo", "note": "Background comfort show since forever.", "rank": 3, "score": 8.6, "movement": "same", "weeks_on_list": 12},
            {"title": "Friends", "added_by": "u7", "note": "I know every episode. Still watch every episode.", "rank": 4, "score": 8.2, "movement": "down", "weeks_on_list": 9},
        ],
        "posts": [
            {"author": "u3", "title": "Ted Lasso", "caption": "Started a rewatch and remembered how much I needed this show. Optimism as a radical act.", "likes": 178, "comments": ["The Roy Kent arc gets me every time.", "Season 2 finale destroyed me.", "This show is a warm hug."]},
            {"author": "u9", "title": "Gilmore Girls", "caption": "It’s October so Stars Hollow season begins. No further explanation needed.", "likes": 155, "comments": ["Annual tradition.", "I still think Luke and Lorelai are endgame.", "The dialogue speed is peak television."]},
            {"author": "u7", "title": "Friends", "caption": "Okay but the Chandler and Monica proposal scene gets better every single rewatch. That writing still holds.", "likes": 122, "comments": ["The ‘she’s my lobster’ rival.", "Chandler’s face when she walks in.", "Early 2000s emotional damage."]},
        ],
    },
    {
        "name": "A24 Inner Circle",
        "slug": "demo-a24-inner-circle",
        "description": "Grief disguised as horror. Longing disguised as cinema. A24 is the studio of the decade.",
        "invite_code": "a24cult",
        "icon": "🎞️",
        "members": ["u_demo", "u1", "u5", "u6", "u7"],
        "titles": [
            {"title": "Hereditary", "added_by": "u5", "note": "The most suffocating family drama ever made. Grief as pure horror.", "rank": 1, "score": 9.5, "movement": "same", "weeks_on_list": 7},
            {"title": "Midsommar", "added_by": "u1", "note": "Daylight shouldn’t be this terrifying.", "rank": 2, "score": 9.2, "movement": "up", "weeks_on_list": 5},
            {"title": "Aftersun", "added_by": "u6", "note": "This film knows what it’s doing to you the whole time.", "rank": 3, "score": 9.0, "movement": "up", "weeks_on_list": 4},
            {"title": "Everything Everywhere All At Once", "added_by": "u7", "note": "Chaos and love as the same thing.", "rank": 4, "score": 8.9, "movement": "down", "weeks_on_list": 6},
            {"title": "Portrait of a Lady on Fire", "added_by": "u_demo", "note": "Visual restraint as emotional maximum.", "rank": 5, "score": 8.8, "movement": "same", "weeks_on_list": 9},
        ],
        "posts": [
            {"author": "u5", "title": "Hereditary", "caption": "Hereditary is not a horror film. It’s a grief film that horror happens to.", "likes": 247, "comments": ["Toni Collette was robbed of every award.", "That dinner scene lingers forever.", "Second watch is even more devastating."]},
            {"author": "u6", "title": "Aftersun", "caption": "The camcorder footage at the end of Aftersun destroyed something in me that hasn’t healed. Paul Mescal is generational.", "likes": 198, "comments": ["That disco scene is haunting.", "The whole film is a memory playing back wrong.", "I needed days to process this."]},
            {"author": "u7", "title": "Everything Everywhere All At Once", "caption": "It shouldn’t work. A24 decided to make the most maximalist thing imaginable and somehow it’s their most emotional film.", "likes": 176, "comments": ["Michelle Yeoh is the greatest of all time.", "The hot dog fingers universe broke me.", "Cried for 40 minutes straight."]},
        ],
    },
    {
        "name": "Crime Scene",
        "slug": "demo-crime-scene",
        "description": "Slow burn detectives, unreliable narrators, and writers who respect the audience.",
        "invite_code": "detect7",
        "icon": "🔍",
        "members": ["u_demo", "u8", "u2", "u4", "u9"],
        "titles": [
            {"title": "Mindhunter", "added_by": "u8", "note": "The most methodical TV ever made. Fincher touch on every frame.", "rank": 1, "score": 9.6, "movement": "same", "weeks_on_list": 9},
            {"title": "True Detective S1", "added_by": "u2", "note": "McConaughey monologues as a whole genre.", "rank": 2, "score": 9.4, "movement": "same", "weeks_on_list": 11},
            {"title": "Breaking Bad", "added_by": "u4", "note": "The only show where every single episode moves the story forward.", "rank": 3, "score": 9.3, "movement": "up", "weeks_on_list": 8},
            {"title": "Zodiac", "added_by": "u9", "note": "Fincher understood that the unsolved case IS the story.", "rank": 4, "score": 9.1, "movement": "up", "weeks_on_list": 5},
            {"title": "The Sopranos", "added_by": "u_demo", "note": "Everything descended from this. Nothing has surpassed it.", "rank": 5, "score": 9.0, "movement": "down", "weeks_on_list": 14},
        ],
        "posts": [
            {"author": "u8", "title": "Mindhunter", "caption": "Mindhunter season 3 will never happen and I will never fully accept it. Holden Ford deserved his ending.", "likes": 312, "comments": ["The BTK episodes were chilling.", "Fincher’s pacing is another language.", "Criminally cancelled."]},
            {"author": "u2", "title": "True Detective S1", "caption": "Rust Cohle’s monologue about time being a flat circle is still the most quotable TV writing in the last 20 years. Change my mind.", "likes": 289, "comments": ["Woody Harrelson was criminally underrated in this.", "The aerial long take at the end of episode 4.", "Dark philosophy as genre entertainment."]},
            {"author": "u4", "title": "Zodiac", "caption": "Zodiac works because Fincher commits to the anti-catharsis. No resolution. Pure obsession. That IS the movie.", "likes": 201, "comments": ["Robert Graysmith’s spiral is terrifying.", "Still one of the most unsettling watch experiences.", "2:40 that flies by."]},
        ],
    },
]

TV_TITLE_HINTS = {
    "Succession", "The Bear", "Girls", "Euphoria", "Severance", "Gilmore Girls", "The Crown", "Breaking Bad",
    "True Detective S1", "Mindhunter", "Friends", "How I Met Your Mother", "The Sopranos", "The Office", "The OC",
    "Ted Lasso", "Fleabag", "The Last of Us", "Mad Men", "True Detective",
}

FOR_YOU_POSTS = [
    {"id": "fy1", "author": "u2", "title": "Succession", "caption": "Succession might be the sharpest character writing of the last decade.", "likes": 842, "comments": ["Roman Roy dialogue is unmatched.", "Every scene feels like a chess match.", "Best finale I’ve seen in years.", "Kieran Culkin absolutely carried."]},
    {"id": "fy2", "author": "u1", "title": "Past Lives", "caption": "Past Lives understands longing in a way most films don’t.", "likes": 411, "comments": ["The silence says more than dialogue.", "Greta Lee was unreal.", "That ending stayed with me."]},
    {"id": "fy3", "author": "u7", "title": "Girls", "caption": "Girls ages with you. I judged them at 21. I get them at 28.", "likes": 366, "comments": ["Hannah feels too real now.", "The friendship chaos makes sense.", "I used to hate-watch. Now I relate."]},
    {"id": "fy4", "author": "u5", "title": "Hereditary", "caption": "Hereditary still might be the most suffocating horror film ever made.", "likes": 529, "comments": ["The dinner scene is unbearable.", "Toni Collette deserved awards.", "Nothing else hits like this."]},
    {"id": "fy5", "author": "u8", "title": "The Bear", "caption": "The Bear captures anxiety better than any thriller.", "likes": 733, "comments": ["Kitchen chaos feels real.", "Episode 7 still stresses me out.", "Jeremy Allen White is perfect."]},
    {"id": "fy6", "author": "u4", "title": "Blade Runner 2049", "caption": "Blade Runner 2049 is pure visual poetry.", "likes": 904, "comments": ["Deakins deserved that Oscar.", "Every frame is insane.", "Soundtrack gives chills."]},
    {"id": "fy7", "author": "u3", "title": "New Girl", "caption": "New Girl remains undefeated comfort TV.", "likes": 189, "comments": ["Nick Miller forever.", "Peak ensemble comedy.", "Schmidt never misses."]},
    {"id": "fy8", "author": "u6", "title": "Aftersun", "caption": "Aftersun quietly breaks your heart without warning.", "likes": 512, "comments": ["Paul Mescal was incredible.", "The final scene destroyed me.", "So subtle but powerful."]},
    {"id": "fy9", "author": "u10", "title": "Dune: Part Two", "caption": "Dune Part Two is scale done right.", "likes": 1122, "comments": ["The worm sequence???", "IMAX is mandatory.", "Pure spectacle."]},
    {"id": "fy10", "author": "u9", "title": "The OC", "caption": "Rewatching The OC and realizing it defined an era.", "likes": 240, "comments": ["Soundtrack is elite.", "Marissa deserved better.", "Sandy Cohen remains king."]},
    {"id": "fy11", "author": "u1", "title": "Call Me By Your Name", "caption": "Sunlight, longing, and that final fireplace scene.", "likes": 378, "comments": ["Sufjan Stevens forever.", "Emotionally devastating.", "I felt this deeply."]},
    {"id": "fy12", "author": "u2", "title": "Oppenheimer", "caption": "Oppenheimer is overwhelming in the best way.", "likes": 954, "comments": ["Cillian Murphy was unreal.", "The sound design shook me.", "Nolan at his peak."]},
    {"id": "fy13", "author": "u7", "title": "Euphoria", "caption": "Euphoria is chaos and vulnerability colliding.", "likes": 488, "comments": ["The cinematography is insane.", "Zendaya carries the emotional weight.", "Every episode feels cinematic."]},
    {"id": "fy14", "author": "u4", "title": "Parasite", "caption": "Parasite remains a masterclass in tension.", "likes": 667, "comments": ["Perfect social commentary.", "Genre blending done right.", "That ending still hits."]},
    {"id": "fy15", "author": "u8", "title": "Severance", "caption": "Severance is the most unsettling office drama ever.", "likes": 822, "comments": ["That hallway scene lives rent free.", "Concept is terrifying.", "Season 2 can’t come fast enough."]},
    {"id": "fy16", "author": "u5", "title": "Midsommar", "caption": "Daylight horror just hits differently.", "likes": 542, "comments": ["Florence Pugh was incredible.", "That opening scene broke me.", "So disturbing but beautiful."]},
    {"id": "fy17", "author": "u3", "title": "Gilmore Girls", "caption": "Fall = Gilmore Girls season.", "likes": 219, "comments": ["Stars Hollow vibes forever.", "Perfect cozy rewatch.", "Lorelai supremacy."]},
    {"id": "fy18", "author": "u6", "title": "Anatomy of a Fall", "caption": "Courtroom tension done right.", "likes": 301, "comments": ["So precise and cold.", "Brilliant performances.", "I couldn’t look away."]},
    {"id": "fy19", "author": "u10", "title": "Mad Max: Fury Road", "caption": "Still the best action movie of the 2010s.", "likes": 944, "comments": ["Nonstop adrenaline.", "Charlize Theron rules.", "Pure practical effects."]},
    {"id": "fy20", "author": "u9", "title": "Friends", "caption": "Background comfort show forever.", "likes": 177, "comments": ["I know every episode.", "Still funny.", "Ultimate comfort."]},
    {"id": "fy21", "author": "u1", "title": "Before Sunrise", "caption": "Conversations that feel real.", "likes": 288, "comments": ["Ethan Hawke peak.", "So intimate.", "Dialogue perfection."]},
    {"id": "fy22", "author": "u2", "title": "The Crown", "caption": "Prestige TV done right.", "likes": 422, "comments": ["Costume design is stunning.", "Historical drama perfection.", "Acting masterclass."]},
    {"id": "fy23", "author": "u7", "title": "Little Women", "caption": "Greta Gerwig understands emotion.", "likes": 355, "comments": ["Florence Pugh was electric.", "Warm and powerful.", "Cried twice."]},
    {"id": "fy24", "author": "u4", "title": "Roma", "caption": "Black and white cinematography perfection.", "likes": 198, "comments": ["Visually breathtaking.", "So immersive.", "Quietly powerful."]},
    {"id": "fy25", "author": "u8", "title": "Zodiac", "caption": "Fincher tension is unmatched.", "likes": 401, "comments": ["Still terrifying.", "Slow burn done right.", "Jake Gyllenhaal was great."]},
    {"id": "fy26", "author": "u5", "title": "The Witch", "caption": "Atmosphere over jump scares always.", "likes": 266, "comments": ["That ending though.", "So unsettling.", "Black Phillip supremacy."]},
    {"id": "fy27", "author": "u3", "title": "Ted Lasso", "caption": "Optimism TV we needed.", "likes": 333, "comments": ["Feel good perfection.", "Jason Sudeikis charm.", "Warm hug show."]},
    {"id": "fy28", "author": "u6", "title": "Moonlight", "caption": "Tender and devastating.", "likes": 451, "comments": ["Visual poetry.", "That final scene.", "So quietly powerful."]},
    {"id": "fy29", "author": "u10", "title": "Top Gun: Maverick", "caption": "Pure crowd-pleasing cinema.", "likes": 1021, "comments": ["IMAX experience.", "Tom Cruise still has it.", "Jet scenes were insane."]},
    {"id": "fy30", "author": "u9", "title": "The Office", "caption": "Comfort rewatch #52.", "likes": 264, "comments": ["Michael Scott forever.", "Still funny.", "Peak sitcom."]},
    {"id": "fy31", "author": "u1", "title": "Portrait of a Lady on Fire", "caption": "Glances say more than words.", "likes": 322, "comments": ["Visual storytelling perfection.", "So intimate.", "That final scene."]},
    {"id": "fy32", "author": "u2", "title": "Breaking Bad", "caption": "Character descent done flawlessly.", "likes": 881, "comments": ["Walter White arc unmatched.", "Every episode matters.", "Peak prestige TV."]},
    {"id": "fy33", "author": "u7", "title": "Lady Bird", "caption": "Coming-of-age perfection.", "likes": 290, "comments": ["So relatable.", "Saoirse Ronan forever.", "Heartfelt and funny."]},
    {"id": "fy34", "author": "u4", "title": "The Godfather", "caption": "Still flawless filmmaking.", "likes": 512, "comments": ["Timeless classic.", "Pacino performance.", "Every frame iconic."]},
    {"id": "fy35", "author": "u8", "title": "True Detective S1", "caption": "Atmosphere and dialogue perfection.", "likes": 643, "comments": ["Matthew McConaughey monologues.", "Dark and philosophical.", "Best season ever."]},
    {"id": "fy36", "author": "u5", "title": "The Babadook", "caption": "Grief horror hits different.", "likes": 188, "comments": ["So emotionally heavy.", "Symbolism everywhere.", "Underrated classic."]},
    {"id": "fy37", "author": "u3", "title": "Pride & Prejudice (2005)", "caption": "Comfort period romance.", "likes": 245, "comments": ["Keira Knightley glow.", "That hand flex moment.", "Soft romance perfection."]},
    {"id": "fy38", "author": "u6", "title": "Whiplash", "caption": "Intensity from start to finish.", "likes": 534, "comments": ["Final scene is electric.", "J.K. Simmons deserved it.", "Pure tension."]},
    {"id": "fy39", "author": "u10", "title": "Interstellar", "caption": "Space epic with heart.", "likes": 1103, "comments": ["Docking scene still insane.", "Hans Zimmer greatness.", "Father-daughter story hits."]},
    {"id": "fy40", "author": "u9", "title": "How I Met Your Mother", "caption": "Comfort rewatch forever.", "likes": 204, "comments": ["Barney one-liners.", "Legend—wait for it—dary.", "Pure nostalgia."]},
    {"id": "fy41", "author": "u1", "title": "Lost in Translation", "caption": "Loneliness captured perfectly.", "likes": 300, "comments": ["Bill Murray energy.", "Quiet and reflective.", "So atmospheric."]},
    {"id": "fy42", "author": "u2", "title": "The Sopranos", "caption": "The blueprint for modern TV.", "likes": 712, "comments": ["Tony Soprano complexity.", "Timeless storytelling.", "Final scene debate."]},
    {"id": "fy43", "author": "u7", "title": "Promising Young Woman", "caption": "Stylish and unsettling.", "likes": 356, "comments": ["Soundtrack hits.", "Carey Mulligan amazing.", "So sharp."]},
    {"id": "fy44", "author": "u4", "title": "The Social Network", "caption": "Dialogue speedrun perfection.", "likes": 487, "comments": ["Aaron Sorkin magic.", "Score is iconic.", "Fincher precision."]},
    {"id": "fy45", "author": "u8", "title": "Mindhunter", "caption": "Criminal psychology done right.", "likes": 421, "comments": ["So meticulously paced.", "Bring it back please.", "Chilling interviews."]},
    {"id": "fy46", "author": "u5", "title": "Get Out", "caption": "Social horror masterpiece.", "likes": 607, "comments": ["Jordan Peele brilliance.", "Clever and terrifying.", "Cultural moment."]},
    {"id": "fy47", "author": "u3", "title": "Mamma Mia!", "caption": "Joyful chaos forever.", "likes": 163, "comments": ["ABBA supremacy.", "Pure serotonin.", "Comfort movie."]},
    {"id": "fy48", "author": "u6", "title": "Everything Everywhere All At Once", "caption": "Multiverse chaos with heart.", "likes": 692, "comments": ["Michelle Yeoh legend.", "So inventive.", "Emotional and wild."]},
    {"id": "fy49", "author": "u10", "title": "The Dark Knight", "caption": "Still peak superhero cinema.", "likes": 1320, "comments": ["Heath Ledger unforgettable.", "Action and depth.", "Timeless."]},
    {"id": "fy50", "author": "u9", "title": "Mean Girls", "caption": "Cultural reset forever.", "likes": 279, "comments": ["So quotable.", "Still funny.", "Regina George icon."]},
]

DISCOVER_POSTS = [
    {"id": "d1", "author": "v1", "title": "Challengers", "caption": "We put everything into this film. See it with a crowd.", "likes": 18342, "comments": ["Opening night tickets booked.", "You were phenomenal in this.", "The tension never lets up.", "Best performance of your career.", "Saw it twice already."], "verified": True},
    {"id": "d2", "author": "v2", "caption": "Behind the scenes — lighting tests before our final shot.", "likes": 9422, "comments": ["This composition is beautiful.", "Cinema lives in details like this.", "That color palette is perfect.", "Directors who care about craft."], "verified": True},
    {"id": "d3", "author": "platform_trending", "caption": "Fleabag is surging again after a viral monologue clip resurfaced.", "likes": 11221, "comments": ["That speech still destroys me.", "Phoebe Waller-Bridge is unmatched.", "Time for another rewatch.", "Modern classic energy.", "Still hits every time."]},
    {"id": "d4", "author": "u_demo", "caption": "🎟 Win tickets to an early screening near you.", "comments": [], "sponsored": True, "cta": "Enter Giveaway"},
    {"id": "d5", "author": "platform_trending", "title": "The Bear", "caption": "The Bear S2 Christmas episode is one of the most discussed episodes of the year.", "likes": 10293, "comments": ["Anxiety levels through the roof.", "Best episode of television in years.", "Painfully relatable chaos.", "Acting masterclass.", "Holiday stress captured perfectly."]},
    {"id": "d6", "author": "v3", "caption": "Writers room energy before our finale rewrite.", "likes": 7712, "comments": ["This is where the magic happens.", "Respect the craft.", "Story first always.", "Finales are brutal to write."], "verified": True},
    {"id": "d7", "author": "platform_trending", "title": "Oppenheimer", "caption": "Oppenheimer returns to IMAX after fan demand.", "likes": 15672, "comments": ["IMAX is the only way.", "That sound design in theaters is unreal.", "Nolan made this for big screens.", "Going again this weekend."]},
    {"id": "d8", "author": "platform_trending", "title": "Barbie", "caption": "Barbie remains one of the most saved films on Scene Snap this month.", "likes": 12231, "comments": ["Still obsessed.", "Production design was insane.", "Ryan Gosling stole every scene.", "Cultural moment."]},
    {"id": "d9", "author": "u_demo", "caption": "📺 Stream the award-winning drama everyone’s talking about.", "comments": [], "sponsored": True, "cta": "Watch Now"},
    {"id": "d10", "author": "v4", "caption": "Festival premiere night. Thank you to everyone who showed up.", "likes": 6811, "comments": ["Festival season is unmatched.", "Indie films deserve this spotlight.", "Congrats to the cast and crew.", "Beautiful moment."], "verified": True},
    {"id": "d11", "author": "platform_trending", "title": "Saltburn", "caption": "Saltburn remains one of the most polarizing films this year.", "likes": 9821, "comments": ["Love it or hate it energy.", "Visually insane.", "I’m still thinking about it.", "That ending shocked me."]},
    {"id": "d12", "author": "platform_trending", "title": "Succession", "caption": "Succession finale discourse resurfaces with anniversary rewatches.", "likes": 11042, "comments": ["Still the best ending.", "Roman Roy hive forever.", "Peak television writing.", "Miss this show daily."]},
    {"id": "d13", "author": "industry_news", "caption": "A24 announces three new projects for 2025 slate.", "likes": 7310, "comments": ["A24 never misses.", "Already excited.", "Indie film renaissance.", "Can’t wait."]},
    {"id": "d14", "author": "platform_trending", "title": "Dune: Part Two", "caption": "Dune Part Two crosses major global box office milestone.", "likes": 14221, "comments": ["Deserved success.", "Sci-fi epic done right.", "The scale is insane.", "Zimmer score lives rent free."]},
    {"id": "d15", "author": "platform_trending", "title": "Severance", "caption": "Severance Season 2 teaser sparks massive fan theories.", "likes": 9210, "comments": ["The concept is terrifying.", "Season 1 ending still haunts me.", "Theories everywhere.", "Best workplace thriller."]},
    {"id": "d16", "author": "u_demo", "caption": "🍿 New releases curated for your watchlist.", "comments": [], "sponsored": True, "cta": "Browse Now"},
    {"id": "d17", "author": "platform_trending", "title": "The Last of Us", "caption": "The Last of Us Season 2 casting news dominates timeline.", "likes": 10431, "comments": ["Perfect casting choice.", "Pedro Pascal supremacy.", "Game adaptation done right.", "Emotional damage incoming."]},
    {"id": "d18", "author": "platform_trending", "title": "Euphoria", "caption": "Euphoria remains one of the most visually discussed shows online.", "likes": 8892, "comments": ["The lighting is insane.", "Zendaya carries every scene.", "Soundtrack never misses.", "Visually unforgettable."]},
    {"id": "d19", "author": "platform_trending", "title": "Poor Things", "caption": "Poor Things wins major production design awards.", "likes": 7601, "comments": ["Set design was unreal.", "So surreal and bold.", "Yorgos Lanthimos vision.", "Emma Stone was incredible."]},
    {"id": "d20", "author": "platform_trending", "title": "Anatomy of a Fall", "caption": "Courtroom dramas see resurgence after Anatomy of a Fall buzz.", "likes": 5481, "comments": ["Tense and precise.", "Smart writing.", "Performances carried it.", "Critically deserved."]},
    {"id": "d21", "author": "platform_trending", "title": "Fleabag", "caption": "‘It’ll pass’ scene trends again on social.", "likes": 12011, "comments": ["That scene wrecks me.", "Timeless writing.", "Phoebe Waller-Bridge genius.", "Still relatable."]},
    {"id": "d22", "author": "industry_news", "caption": "Streaming platforms report major spike in rewatch culture.", "likes": 3921, "comments": ["Comfort shows forever.", "Rewatching hits different.", "Nostalgia content rules.", "So true."]},
    {"id": "d23", "author": "platform_trending", "title": "Interstellar", "caption": "Interstellar re-release rumors excite fans.", "likes": 10220, "comments": ["Docking scene IMAX please.", "Zimmer score supremacy.", "Cried in theaters.", "Going again."]},
    {"id": "d24", "author": "platform_trending", "title": "The Social Network", "caption": "The Social Network clips trend as tech biopics resurface.", "likes": 4832, "comments": ["Sorkin dialogue speedrun.", "Fincher precision.", "Still relevant.", "Score is iconic."]},
    {"id": "d25", "author": "platform_trending", "title": "Breaking Bad", "caption": "Breaking Bad remains most completed prestige series on platform.", "likes": 12903, "comments": ["Perfect character arc.", "Walter White descent unmatched.", "Every episode matters.", "Peak prestige."]},
    {"id": "d26", "author": "u_demo", "caption": "🎬 Director commentary now streaming.", "comments": [], "sponsored": True, "cta": "Watch Extras"},
    {"id": "d27", "author": "platform_trending", "title": "Mad Men", "caption": "Mad Men aesthetic resurges on style feeds.", "likes": 6204, "comments": ["Don Draper visuals unmatched.", "Costume design perfection.", "Moody lighting forever.", "Style icon show."]},
    {"id": "d28", "author": "platform_trending", "title": "Parasite", "caption": "Parasite re-enters global trending lists.", "likes": 10022, "comments": ["Still perfect.", "Genre blending mastery.", "That final act tension.", "Modern classic."]},
    {"id": "d29", "author": "platform_trending", "title": "Moonlight", "caption": "Moonlight clips trend during Pride Month programming.", "likes": 8102, "comments": ["Tender and powerful.", "Visual poetry.", "Emotionally unforgettable.", "Beautiful film."]},
    {"id": "d30", "author": "platform_trending", "title": "Everything Everywhere All At Once", "caption": "Multiverse films see surge after awards season.", "likes": 11200, "comments": ["So inventive.", "Michelle Yeoh legend.", "Emotional chaos done right.", "Still thinking about it."]},
    {"id": "d31", "author": "platform_trending", "title": "The Sopranos", "caption": "Sopranos anniversary sparks rewatch marathons.", "likes": 9211, "comments": ["Blueprint for modern TV.", "Tony Soprano complexity.", "Timeless storytelling.", "Finale still debated."]},
    {"id": "d32", "author": "platform_trending", "title": "True Detective", "caption": "True Detective S1 still dominates best-season debates.", "likes": 7004, "comments": ["McConaughey monologues unmatched.", "Atmosphere perfection.", "Dark and philosophical.", "Best season ever."]},
    {"id": "d33", "author": "platform_trending", "title": "Call Me By Your Name", "caption": "Summer romance films trend with seasonal playlists.", "likes": 5341, "comments": ["Sunlight cinematography.", "Sufjan Stevens forever.", "Soft heartbreak.", "Atmospheric beauty."]},
    {"id": "d34", "author": "platform_trending", "title": "Zodiac", "caption": "Fincher thrillers dominate late-night streaming stats.", "likes": 6621, "comments": ["Slow burn mastery.", "Tension through silence.", "Gyllenhaal performance underrated.", "Still chilling."]},
    {"id": "d35", "author": "platform_trending", "title": "The Dark Knight", "caption": "The Dark Knight returns to top superhero rankings.", "likes": 15812, "comments": ["Heath Ledger legacy.", "Peak genre filmmaking.", "Timeless villain performance.", "Still unmatched."]},
    {"id": "d36", "author": "platform_trending", "title": "Mean Girls", "caption": "Mean Girls remains endlessly quotable.", "likes": 7802, "comments": ["Cultural reset forever.", "So rewatchable.", "Regina George icon.", "Still hilarious."]},
    {"id": "d37", "author": "platform_trending", "title": "Lady Bird", "caption": "Coming-of-age films see renewed interest.", "likes": 6012, "comments": ["So relatable.", "Heartfelt storytelling.", "Saoirse Ronan forever.", "Warm and honest."]},
    {"id": "d38", "author": "platform_trending", "title": "The Office", "caption": "The Office remains most rewatched sitcom.", "likes": 12503, "comments": ["Comfort TV forever.", "Michael Scott supremacy.", "Background binge staple.", "Never gets old."]},
    {"id": "d39", "author": "platform_trending", "title": "Friends", "caption": "Friends nostalgia cycle continues.", "likes": 11132, "comments": ["Ultimate comfort show.", "Soundtrack memories.", "Iconic sitcom energy.", "Still funny."]},
    {"id": "d40", "author": "u_demo", "caption": "🎟 Exclusive behind-the-scenes content now available.", "comments": [], "sponsored": True, "cta": "Watch Now"},
    {"id": "d41", "author": "platform_trending", "title": "Whiplash", "caption": "Music dramas surge in popularity.", "likes": 5402, "comments": ["Final scene electric.", "J.K. Simmons intensity.", "Pure tension filmmaking.", "Unforgettable ending."]},
    {"id": "d42", "author": "platform_trending", "title": "Her", "caption": "Soft sci-fi romance resurges in curated lists.", "likes": 4903, "comments": ["Lonely but beautiful.", "Joaquin Phoenix performance.", "Visually dreamy.", "Emotional storytelling."]},
    {"id": "d43", "author": "platform_trending", "title": "Get Out", "caption": "Social horror remains culturally relevant.", "likes": 10211, "comments": ["Jordan Peele brilliance.", "Clever and tense.", "Modern classic horror.", "Still powerful."]},
    {"id": "d44", "author": "platform_trending", "title": "Little Women", "caption": "Period dramas trend during awards discourse.", "likes": 4502, "comments": ["Greta Gerwig storytelling.", "Florence Pugh performance.", "Warm and emotional.", "Beautiful adaptation."]},
    {"id": "d45", "author": "platform_trending", "title": "Blade Runner 2049", "caption": "Sci-fi visuals dominate cinematography rankings.", "likes": 8711, "comments": ["Every frame stunning.", "Deakins masterpiece.", "Atmospheric perfection.", "Visual poetry."]},
    {"id": "d46", "author": "platform_trending", "title": "Midsommar", "caption": "Daylight horror continues to trend.", "likes": 7301, "comments": ["Unsettling visuals.", "Florence Pugh carried.", "Disturbing and beautiful.", "Haunting atmosphere."]},
    {"id": "d47", "author": "platform_trending", "title": "Gilmore Girls", "caption": "Fall viewing season sparks Gilmore Girls rewatch wave.", "likes": 5202, "comments": ["Stars Hollow comfort.", "Perfect autumn show.", "Cozy vibes forever.", "Seasonal staple."]},
    {"id": "d48", "author": "platform_trending", "title": "Before Sunrise", "caption": "Romantic dialogue classics resurface in lists.", "likes": 4012, "comments": ["So intimate.", "Conversations feel real.", "Ethan Hawke peak.", "Quiet romance perfection."]},
    {"id": "d49", "author": "platform_trending", "title": "Roma", "caption": "Black-and-white cinema resurges in film circles.", "likes": 3120, "comments": ["Visually breathtaking.", "Quietly powerful.", "Immersive storytelling.", "Art house excellence."]},
    {"id": "d50", "author": "platform_trending", "title": "Portrait of a Lady on Fire", "caption": "Slow-burn romances trend in curated feeds.", "likes": 5221, "comments": ["Glances speak volumes.", "Visual storytelling perfection.", "Emotionally devastating.", "Modern masterpiece."]},
]


def _infer_content_type(title: str) -> str:
    return "series" if title in TV_TITLE_HINTS else "movie"


def _stable_tmdb_id(title: str) -> int:
    return 9000000 + (sum(ord(char) for char in title) % 900000)


def _uploads_root() -> Path:
    return settings.uploads_path()


def _is_external_image_url(url: str | None) -> bool:
    if not url:
        return False
    lowered = url.lower()
    return lowered.startswith("https://") and (
        "image.tmdb.org" in lowered
        or "wikipedia.org" in lowered
        or "wikimedia.org" in lowered
    )


def _resolve_tmdb_match(db: Session, title_name: str, content_type: str) -> ContentTitle | None:
    try:
        candidates = tmdb_search_titles(db, title_name)
    except Exception:
        return None
    if not candidates:
        return None

    normalized = title_name.strip().lower()
    exact = [
        row
        for row in candidates
        if row.content_type == content_type and (row.title or "").strip().lower() == normalized
    ]
    selected = exact[0] if exact else next((row for row in candidates if row.content_type == content_type), candidates[0])
    try:
        return refresh_title_details(db, selected)
    except Exception:
        return selected


def _media_urls(subdir: str) -> list[str]:
    root = _uploads_root() / subdir
    if not root.exists():
        return []
    urls: list[str] = []
    for file in sorted(root.iterdir()):
        if file.is_file() and file.suffix.lower() in MEDIA_EXTENSIONS:
            urls.append(f"/media/{subdir}/{file.name}")
    return urls


def _avatar_assignments() -> dict[str, str]:
    assignable_codes = [entry["code"] for entry in DEMO_USERS if entry["code"] not in SCENESNAP_ACCOUNT_CODES]

    # Prefer explicit avatar pool assets uploaded for demo users.
    user_uploads = [url for url in _media_urls("users") if "seensnap_logo" not in url.lower()]
    preferred_pool = [url for url in user_uploads if "/avatar_pool_" in url.lower()]

    # Fall back to non-placeholder user uploads, then generic avatar uploads.
    filtered_user_uploads = [url for url in user_uploads if "headshot_to_be_provided" not in url.lower()]
    fallback_uploads = [url for url in _media_urls("avatars") if "seensnap_logo" not in url.lower()]
    pool = preferred_pool or filtered_user_uploads or fallback_uploads
    if not pool:
        return {code: "/media/brand/title_placeholder.jpg" for code in assignable_codes}

    # Optional seed for reproducibility when needed; defaults to fresh random assignment.
    seed_value = os.getenv("SEENSNAP_DEMO_AVATAR_SEED")
    rng = random.Random(int(seed_value)) if seed_value and seed_value.isdigit() else random.Random()
    shuffled = list(pool)
    rng.shuffle(shuffled)
    return {code: shuffled[idx % len(shuffled)] for idx, code in enumerate(assignable_codes)}


def _title_fallback_poster(title_name: str) -> str:
    posters = [url for url in _media_urls("titles") if "seensnap_logo" not in url]
    if not posters:
        return "/media/brand/seensnap_logo.png"
    index = sum(ord(char) for char in title_name) % len(posters)
    return posters[index]


def _upsert_user(db: Session, user_data: dict) -> User:
    email = DEMO_EMAIL if user_data["code"] == "u_demo" else f"{user_data['username'].lower()}@demo.seensnap.local"
    user = db.scalar(select(User).where(func.lower(User.email) == email))
    if user is None:
        user = User(email=email, auth_provider="demo", is_demo=True)
        db.add(user)
        db.flush()
    elif not user.is_demo:
        user.is_demo = True

    profile = db.scalar(select(UserProfile).where(UserProfile.user_id == user.id))
    if profile is None:
        profile = UserProfile(user_id=user.id)
        db.add(profile)

    profile.username = user_data["username"][:32]
    profile.display_name = user_data["name"]
    profile.avatar_url = user_data["avatar"]
    profile.bio = user_data.get("bio")
    profile.favorite_genres = []
    profile.country_code = "US"

    preferences = db.scalar(select(UserPreferences).where(UserPreferences.user_id == user.id))
    if preferences is None:
        db.add(UserPreferences(user_id=user.id))

    return user


def _upsert_title(db: Session, title_name: str) -> ContentTitle:
    content_type = _infer_content_type(title_name)
    fallback_poster = _title_fallback_poster(title_name)

    # Prefer a TMDB-backed row first so social feed cards use real posters.
    tmdb_row = _resolve_tmdb_match(db, title_name, content_type)
    if tmdb_row is not None:
        if not _is_external_image_url(tmdb_row.poster_url):
            try:
                wiki = resolve_wikipedia_metadata(
                    title=tmdb_row.title or title_name,
                    release_date=tmdb_row.release_date,
                    content_type=tmdb_row.content_type,
                )
            except Exception:
                wiki = None
            if wiki and wiki.image_url:
                tmdb_row.poster_url = wiki.image_url
                tmdb_row.backdrop_url = tmdb_row.backdrop_url or wiki.image_url
                db.flush()
        return tmdb_row

    existing = db.scalar(
        select(ContentTitle)
        .where(func.lower(ContentTitle.title) == title_name.lower(), ContentTitle.content_type == content_type)
        .order_by(ContentTitle.updated_at.desc())
    )
    if existing is not None:
        if not _is_external_image_url(existing.poster_url):
            try:
                wiki = resolve_wikipedia_metadata(
                    title=existing.title or title_name,
                    release_date=existing.release_date,
                    content_type=existing.content_type,
                )
            except Exception:
                wiki = None
            if wiki and wiki.image_url:
                existing.poster_url = wiki.image_url
                existing.backdrop_url = existing.backdrop_url or wiki.image_url
            else:
                existing.poster_url = existing.poster_url or fallback_poster
                existing.backdrop_url = existing.backdrop_url or existing.poster_url
            db.flush()
        return existing

    tmdb_id = _stable_tmdb_id(title_name)
    while db.scalar(select(ContentTitle).where(ContentTitle.tmdb_id == tmdb_id)) is not None:
        tmdb_id += 1
    title = ContentTitle(
        tmdb_id=tmdb_id,
        content_type=content_type,
        title=title_name,
        original_title=title_name,
        overview=title_name,
        poster_url=fallback_poster,
        backdrop_url=fallback_poster,
        genres=[],
        metadata_raw={"seed_tag": SEED_TAG, "seeded": True},
    )
    db.add(title)
    db.flush()
    return title


def _reaction_counts_from_likes(likes: int) -> dict[str, int]:
    base = max(1, min(32, likes // 120))
    return {
        "heart": max(1, base),
        "fire": max(0, base // 2),
        "thumbs_down": 0,
        "tomato": 0,
    }


def _add_reactions(db: Session, event: FeedEvent, counts: dict[str, int], reactors: list[User]) -> None:
    idx = 0
    for reaction, count in counts.items():
        for _ in range(count):
            if idx >= len(reactors):
                return
            reactor = reactors[idx]
            idx += 1
            db.add(FeedReaction(event_id=event.id, user_id=reactor.id, reaction=reaction))


def _add_comments(db: Session, event: FeedEvent, comments: list[str], commenters: list[User]) -> None:
    for idx, body in enumerate(comments):
        commenter = commenters[idx % len(commenters)]
        db.add(FeedComment(event_id=event.id, user_id=commenter.id, body=body))


def _seed_watchlists(
    db: Session,
    *,
    current_user: User,
    titles_by_name: dict[str, ContentTitle],
) -> None:
    watchlists = ensure_default_watchlists(db, current_user.id)
    by_name = {watchlist.name: watchlist for watchlist in watchlists}
    watchlist_ids = [watchlist.id for watchlist in watchlists]
    if watchlist_ids:
        db.execute(delete(WatchlistItem).where(WatchlistItem.watchlist_id.in_(watchlist_ids)))

    for list_name, title_names in WATCHLIST_SEED.items():
        watchlist = by_name.get(list_name)
        if watchlist is None:
            continue
        for idx, title_name in enumerate(title_names):
            title = titles_by_name.get(title_name)
            if title is None:
                continue
            db.add(
                WatchlistItem(
                    watchlist_id=watchlist.id,
                    content_title_id=title.id,
                    added_via="demo_seed",
                    position=idx + 1,
                )
            )


def _delete_seeded_teams(db: Session) -> None:
    seeded_slugs = [row["slug"] for row in WATCH_TEAM_SEED]
    seeded_teams = db.scalars(select(Team).where(Team.slug.in_(seeded_slugs))).all()
    if not seeded_teams:
        return

    team_ids = [team.id for team in seeded_teams]
    team_event_ids = db.scalars(select(FeedEvent.id).where(FeedEvent.team_id.in_(team_ids))).all()
    if team_event_ids:
        db.execute(delete(FeedReaction).where(FeedReaction.event_id.in_(team_event_ids)))
        db.execute(delete(FeedComment).where(FeedComment.event_id.in_(team_event_ids)))
    db.execute(delete(FeedEvent).where(FeedEvent.team_id.in_(team_ids)))
    db.execute(delete(TeamAnalyticsSnapshot).where(TeamAnalyticsSnapshot.team_id.in_(team_ids)))
    db.execute(delete(TeamActivity).where(TeamActivity.team_id.in_(team_ids)))
    db.execute(delete(TeamRanking).where(TeamRanking.team_id.in_(team_ids)))
    db.execute(delete(TeamTitle).where(TeamTitle.team_id.in_(team_ids)))
    db.execute(delete(TeamMember).where(TeamMember.team_id.in_(team_ids)))
    db.execute(delete(Team).where(Team.id.in_(team_ids)))


def _seed_watch_teams(
    db: Session,
    *,
    users_by_code: dict[str, User],
    titles_by_name: dict[str, ContentTitle],
    commenter_pool: list[User],
    reactor_pool: list[User],
    now: datetime,
) -> None:
    _delete_seeded_teams(db)

    for team_idx, team_seed in enumerate(WATCH_TEAM_SEED):
        owner = users_by_code[team_seed["members"][0]]
        team = Team(
            name=team_seed["name"],
            slug=team_seed["slug"],
            description=team_seed["description"],
            visibility="private",
            icon=team_seed["icon"],
            owner_user_id=owner.id,
            invite_code=team_seed["invite_code"],
            max_members=max(8, len(team_seed["members"]) + 2),
            last_activity_at=now - timedelta(hours=team_idx),
        )
        db.add(team)
        db.flush()

        for member_idx, member_code in enumerate(team_seed["members"]):
            db.add(
                TeamMember(
                    team_id=team.id,
                    user_id=users_by_code[member_code].id,
                    role="owner" if member_idx == 0 else "member",
                    status="active",
                )
            )

        db.add(
            TeamActivity(
                team_id=team.id,
                actor_user_id=owner.id,
                activity_type="team_created",
                entity_id=team.id,
                payload={"team_name": team.name, "seed_tag": SEED_TAG},
                created_at=now - timedelta(days=6 - team_idx),
            )
        )

        for title_seed in team_seed["titles"]:
            title = titles_by_name.get(title_seed["title"])
            if title is None:
                continue
            actor = users_by_code[title_seed["added_by"]]
            team_title = TeamTitle(
                team_id=team.id,
                content_title_id=title.id,
                added_by_user_id=actor.id,
                note=title_seed["note"],
                added_at=now - timedelta(days=5 - team_idx, hours=title_seed["rank"]),
            )
            db.add(team_title)
            db.flush()
            db.add(
                TeamRanking(
                    team_id=team.id,
                    content_title_id=title.id,
                    rank=title_seed["rank"],
                    score=title_seed["score"],
                    movement=title_seed["movement"],
                    weeks_on_list=title_seed["weeks_on_list"],
                )
            )
            db.add(
                TeamActivity(
                    team_id=team.id,
                    actor_user_id=actor.id,
                    activity_type="title_added",
                    content_title_id=title.id,
                    entity_id=team_title.id,
                    payload={"title_name": title.title, "note": title_seed["note"], "seed_tag": SEED_TAG},
                    created_at=now - timedelta(days=4 - team_idx, hours=title_seed["rank"]),
                )
            )

        for post_idx, post_seed in enumerate(team_seed["posts"]):
            actor = users_by_code[post_seed["author"]]
            title = titles_by_name.get(post_seed.get("title", ""))
            event = create_feed_event(
                db,
                actor_user_id=actor.id,
                team_id=team.id,
                content_title_id=title.id if title else None,
                event_type="team_post",
                source_type="demo_seed_team",
                payload={
                    "seed_tag": SEED_TAG,
                    "segment": "watch-teams",
                    "body": post_seed["caption"],
                    "caption": post_seed["caption"],
                    "title_name": title.title if title else None,
                    "action_label": "posted to the watch team",
                    "team_name": team.name,
                    "likes": post_seed["likes"],
                    "comment_count": len(post_seed["comments"]),
                    "shares": max(1, int(post_seed["likes"]) // 35),
                },
            )
            event.created_at = now - timedelta(hours=team_idx * 9 + post_idx * 3 + 1)
            _add_reactions(db, event, _reaction_counts_from_likes(int(post_seed["likes"])), reactor_pool)
            _add_comments(db, event, post_seed["comments"], commenter_pool)
            db.add(
                TeamActivity(
                    team_id=team.id,
                    actor_user_id=actor.id,
                    activity_type="team_post",
                    content_title_id=title.id if title else None,
                    entity_id=event.id,
                    payload={"text": post_seed["caption"], "title_name": title.title if title else None, "seed_tag": SEED_TAG},
                    created_at=event.created_at,
                )
            )
        team.last_activity_at = now - timedelta(hours=team_idx)


def seed_demo_feed() -> None:
    db = SessionLocal()
    try:
        ensure_follows_table(db)

        demo_event_ids = select(FeedEvent.id).where(FeedEvent.payload["seed_tag"].astext.like("demo_feed_v%"))
        db.execute(delete(FeedReaction).where(FeedReaction.event_id.in_(demo_event_ids)))
        db.execute(delete(FeedComment).where(FeedComment.event_id.in_(demo_event_ids)))
        db.execute(delete(FeedEvent).where(FeedEvent.payload["seed_tag"].astext.like("demo_feed_v%")))

        users_by_code: dict[str, User] = {}
        avatar_map = _avatar_assignments()
        for entry in DEMO_USERS:
            hydrated_entry = dict(entry)
            if hydrated_entry["code"] not in SCENESNAP_ACCOUNT_CODES:
                existing_avatar = hydrated_entry.get("avatar", "") or ""
                if not existing_avatar.startswith("https://"):
                    hydrated_entry["avatar"] = avatar_map.get(hydrated_entry["code"], existing_avatar)
            users_by_code[entry["code"]] = _upsert_user(db, hydrated_entry)

        demo_user_ids = {user.id for user in users_by_code.values()}
        db.execute(delete(UserFollow).where(UserFollow.follower_user_id.in_(demo_user_ids) | UserFollow.following_user_id.in_(demo_user_ids)))

        current_user = users_by_code["u_demo"]
        for followed_code in FOLLOWING_SEED:
            db.add(UserFollow(follower_user_id=current_user.id, following_user_id=users_by_code[followed_code].id))

        seeded_titles = {post["title"] for post in FOR_YOU_POSTS + DISCOVER_POSTS if post.get("title")}
        titles_by_name = {title_name: _upsert_title(db, title_name) for title_name in sorted(seeded_titles)}

        commenter_pool = [users_by_code[code] for code in ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"]]
        reactor_pool = commenter_pool + [users_by_code["u_demo"], users_by_code["platform_trending"], users_by_code["industry_news"]]

        now = datetime.now(UTC)
        _seed_watchlists(db, current_user=current_user, titles_by_name=titles_by_name)
        _seed_watch_teams(
            db,
            users_by_code=users_by_code,
            titles_by_name=titles_by_name,
            commenter_pool=commenter_pool,
            reactor_pool=reactor_pool,
            now=now,
        )
        all_posts = [("for_you", row) for row in FOR_YOU_POSTS] + [("discover", row) for row in DISCOVER_POSTS]

        for idx, (segment, row) in enumerate(all_posts):
            author_code = row["author"]
            author = users_by_code[author_code]
            title = titles_by_name.get(row.get("title"))
            likes = int(row.get("likes", 0))
            comments = row.get("comments", [])

            event = create_feed_event(
                db,
                actor_user_id=author.id,
                team_id=None,
                content_title_id=title.id if title else None,
                event_type="sponsored_post" if row.get("sponsored") else "user_post",
                source_type="demo_seed",
                source_id=None,
                payload={
                    "seed_tag": SEED_TAG,
                    "segment": segment,
                    "post_id": row["id"],
                    "body": row["caption"],
                    "action_label": "shared a post" if segment == "for_you" else "platform update",
                    "cta": row.get("cta") or ("See Details" if row.get("title") else "View Post"),
                    "likes": likes,
                    "comment_count": len(comments),
                    "shares": max(1, likes // 40) if likes else 0,
                    "verified": True if segment == "discover" else bool(row.get("verified", False)),
                    "sponsored": bool(row.get("sponsored", False)),
                    "trend_score": min(99, max(0, likes // 200)) if segment == "discover" else 0,
                    "platform_engagement": likes if segment == "discover" else 0,
                },
            )
            event.created_at = now - timedelta(minutes=(len(all_posts) - idx) * 17)

            _add_reactions(db, event, _reaction_counts_from_likes(likes), reactor_pool)
            _add_comments(db, event, comments, commenter_pool)

        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    seed_demo_feed()
