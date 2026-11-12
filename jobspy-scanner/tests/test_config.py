import pytest

from jobspy.model import Site

from scanner.config import DEFAULT_SITES, parse_config


def test_defaults_come_from_the_mail_configs_lists():
    c = parse_config('[profile]\ntarget_titles = ["A", " B "]\nlocations = ["Boston, MA"]')
    assert (c.titles, c.locations) == (["A", "B"], ["Boston, MA"])
    assert c.sites == DEFAULT_SITES == [Site.INDEED, Site.LINKEDIN, Site.GLASSDOOR, Site.ZIP_RECRUITER]
    assert (c.results_wanted, c.hours_old, c.concurrency) == (15, 48, 2)
    assert (c.max_postings, c.extract_concurrency) == (200, 8)
    assert c.fetch_descriptions is True


def test_the_jobspy_tables_lists_replace_the_profiles_for_the_scan():
    c = parse_config(
        '[profile]\ntarget_titles = ["A"]\nlocations = ["Burnaby", "Surrey"]\n'
        '[jobspy]\ntitles = ["a OR b"]\nlocations = ["Vancouver, BC", "Remote (Canada)"]\n'
    )
    assert (c.titles, c.locations) == (["a OR b"], ["Vancouver, BC", "Remote (Canada)"])
    # An empty list falls back to the profile's, as for titles.
    c = parse_config('[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nlocations = []\n')
    assert c.locations == ["X"]


def test_the_jobspy_table_overrides():
    c = parse_config(
        '[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n'
        '[jobspy]\ntitles = ["Only This"]\nsites = ["indeed"]\nresults_wanted = 5\n'
        "hours_old = 24\nconcurrency = 1\nfetch_descriptions = false\n"
    )
    assert c.titles == ["Only This"]
    assert (c.sites, c.results_wanted, c.hours_old, c.concurrency) == ([Site.INDEED], 5, 24, 1)
    assert c.fetch_descriptions is False


@pytest.mark.parametrize(
    "text, message",
    [
        ("not toml [", "Expected"),
        ('[profile]\nlocations = ["X"]', "no target_titles"),
        ('[profile]\ntarget_titles = ["A"]', "no locations"),
        ('[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nsites = ["monster"]', "sites"),
        ('[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nconcurrency = 0', "concurrency"),
        ('[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nenabled = false', "enabled"),
        ('[profile]\ntarget_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nresult_wanted = 5', "result_wanted"),
        ('[profile]\ntarget_titles = "A"\nlocations = ["X"]', "target_titles|titles"),
    ],
)
def test_a_bad_config_says_why(text, message):
    with pytest.raises(ValueError, match=message):
        parse_config(text)
