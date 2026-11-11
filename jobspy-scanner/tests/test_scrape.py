from scanner.config import parse_config
from scanner.scrape import remote_country, run_searches, searches

from .helpers import INDEED, LINKEDIN, frame

CONFIG = parse_config(
    '[profile]\ntarget_titles = ["A", "B"]\nlocations = ["Boston, MA", "Remote (US)"]\n[jobspy]\nconcurrency = 2'
)


def test_one_search_per_title_and_location():
    assert searches(CONFIG) == [
        ("A", "Boston, MA"),
        ("A", "Remote (US)"),
        ("B", "Boston, MA"),
        ("B", "Remote (US)"),
    ]


def test_remote_searches_name_the_country():
    assert remote_country("Remote (US)") == "USA"
    assert remote_country("Remote (Canada)") == "Canada"
    assert remote_country("Remote") == "USA"


def test_each_search_is_passed_the_configs_options():
    calls = []

    def scrape(**kwargs):
        calls.append(kwargs)
        return frame(INDEED)

    out = run_searches(CONFIG, scrape)
    assert len(calls) == 4 and len(out.rows) == 4 and out.warnings == []
    boston = next(c for c in calls if c["location"] == "Boston, MA")
    assert boston["is_remote"] is False and boston["site_name"] == [s.value for s in CONFIG.sites]
    assert boston["results_wanted"] == 15 and boston["hours_old"] == 48
    assert boston["linkedin_fetch_description"] is True
    assert boston["description_format"] == "plain"
    remote = next(c for c in calls if c["location"] == "USA")
    assert remote["is_remote"] is True


def test_a_failed_search_is_a_warning_and_the_others_still_count():
    def scrape(**kwargs):
        if kwargs["search_term"] == "A":
            raise RuntimeError("429 for https://example.com/secret")
        return frame(LINKEDIN)

    out = run_searches(CONFIG, scrape)
    assert len(out.rows) == 2
    assert out.warnings == ["jobspy: 2 of 4 searches failed"]
    assert "secret" not in " ".join(out.warnings)


def test_a_site_that_goes_quiet_shows_as_silent_searches():
    # Glassdoor is blocked: the search still succeeds, it just has no Glassdoor rows.
    def scrape(**_):
        return frame(INDEED, LINKEDIN)

    out = run_searches(CONFIG, scrape)
    assert (out.stats()["searches"], out.stats()["failed"]) == (4, 0)
    assert out.stats()["sites"]["indeed"] == {"rows": 4, "silent": 0}
    assert out.stats()["sites"]["glassdoor"] == {"rows": 0, "silent": 4}


def test_a_failed_search_is_not_a_silent_one():
    def scrape(**kwargs):
        if kwargs["search_term"] == "A":
            raise RuntimeError("blocked")
        return frame(INDEED)

    stats = run_searches(CONFIG, scrape).stats()
    assert stats["failed"] == 2 and stats["sites"]["indeed"] == {"rows": 2, "silent": 0}
    assert stats["sites"]["linkedin"]["silent"] == 2


def test_searches_that_find_nothing_are_counted():
    out = run_searches(CONFIG, lambda **_: frame())
    assert out.rows == [] and out.warnings == ["jobspy: 4 of 4 searches found nothing"]


def test_searches_still_running_at_the_budget_are_given_up_on():
    import threading

    release = threading.Event()

    def scrape(**_):
        release.wait(5)
        return frame(INDEED)

    one = parse_config('[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nconcurrency = 1')
    out = run_searches(one, scrape, budget=0.05)
    release.set()
    assert out.rows == [] and out.warnings == ["jobspy: 1 searches unfinished after 0s"]


def test_the_options_are_ones_the_installed_jobspy_takes():
    import inspect

    from jobspy import scrape_jobs

    sent = {}
    run_searches(CONFIG, lambda **kw: sent.update(kw) or frame())
    inspect.signature(scrape_jobs).bind(**sent)
