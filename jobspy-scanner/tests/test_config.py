import pytest

from scanner.config import DEFAULT_SITES, ConfigError, parse_config


def test_defaults_come_from_the_mail_configs_lists():
    c = parse_config('target_titles = ["A", " B "]\nlocations = ["Boston, MA"]')
    assert (c.titles, c.locations) == (("A", "B"), ("Boston, MA",))
    assert c.sites == DEFAULT_SITES
    assert (c.enabled, c.results_wanted, c.hours_old, c.concurrency) == (True, 15, 48, 2)
    assert c.fetch_descriptions is True


def test_the_jobspy_table_overrides():
    c = parse_config(
        'target_titles = ["A"]\nlocations = ["X"]\n'
        '[jobspy]\ntitles = ["Only This"]\nsites = ["indeed"]\nresults_wanted = 5\n'
        "hours_old = 24\nconcurrency = 1\nfetch_descriptions = false\n"
    )
    assert c.titles == ("Only This",)
    assert (c.sites, c.results_wanted, c.hours_old, c.concurrency) == (("indeed",), 5, 24, 1)
    assert c.fetch_descriptions is False


def test_a_config_that_turns_it_off_needs_no_searches():
    assert parse_config("[jobspy]\nenabled = false").enabled is False


@pytest.mark.parametrize(
    "text, message",
    [
        ("not toml [", "not valid TOML"),
        ('locations = ["X"]', "no target_titles"),
        ('target_titles = ["A"]', "no locations"),
        ('target_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nsites = ["monster"]', "unknown monster"),
        ('target_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nconcurrency = 0', "concurrency"),
        ('target_titles = ["A"]\nlocations = ["X"]\n[jobspy]\nenabled = "yes"', "enabled"),
        ('target_titles = "A"\nlocations = ["X"]', "list of strings"),
    ],
)
def test_a_bad_config_says_why(text, message):
    with pytest.raises(ConfigError, match=message):
        parse_config(text)
