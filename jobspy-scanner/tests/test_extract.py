import json

import pytest

from scanner.extract import (
    MAX_DESCRIPTION_CHARS,
    SYSTEM,
    Extracted,
    Extractor,
    extract_all,
    extractor_from_env,
    user_message,
)

from .helpers import INDEED, PYTHON_ROLE, FakeOpenAI, extractor


def test_the_model_sees_only_the_fields_it_needs():
    sent = json.loads(user_message({**INDEED, "job_url": "https://secret.example", "date_posted": None}))
    assert set(sent) == {
        "title", "company", "location", "is_remote", "min_amount", "max_amount",
        "interval", "currency", "description",
    }  # fmt: skip
    assert sent["min_amount"] == 120000.0 and sent["company"] == "Acme Pay"


def test_a_missing_cell_is_null_and_a_long_description_is_cut():
    row = {**INDEED, "min_amount": float("nan"), "description": "x" * 10_000}
    sent = json.loads(user_message(row))
    assert sent["min_amount"] is None
    assert len(sent["description"]) == MAX_DESCRIPTION_CHARS


def test_one_structured_call_per_posting():
    client = FakeOpenAI()
    result, usage = Extractor(client, "dep").extract(INDEED)  # type: ignore[arg-type]
    assert result == PYTHON_ROLE and (usage.input, usage.output) == (100, 20)
    (request,) = client.requests
    assert request["model"] == "dep" and request["response_format"] is Extracted
    assert request["messages"][0] == {"role": "system", "content": SYSTEM}
    assert "reasoning_effort" not in request  # the scanner never sets one


def test_an_answer_that_cannot_be_parsed_is_an_error():
    with pytest.raises(ValueError, match="refused"):
        extractor(lambda **_: None).extract(INDEED)


def test_results_stay_in_row_order_and_a_failure_leaves_a_gap():
    def answer(**kwargs):
        title = json.loads(kwargs["messages"][1]["content"])["title"]
        if title == "bad":
            raise RuntimeError("429 https://example.com/secret")
        return Extracted(workplace="remote", salary="", requirements=[title], skills=[])

    rows = [{**INDEED, "title": t} for t in ("a", "bad", "c")]
    out = extract_all(rows, extractor(answer), concurrency=3, budget=5)
    assert [r.requirements if r else None for r in out.results] == [["a"], None, ["c"]]
    assert (out.failed, out.unfinished) == (1, 0)
    assert (out.usage.input, out.usage.output) == (200, 40)
    assert (out.usage.cached, out.usage.reasoning) == (80, 10)
    assert out.usage.as_json() == {
        "input": 200,
        "output": 40,
        "cached": 80,
        "reasoning": 10,
        "models": ["extract-deployment-2026-03-17"],
    }


def test_a_provider_that_reports_no_details_counts_zero_for_them():
    from types import SimpleNamespace

    from scanner.extract import usage_of

    from openai.types.completion_usage import CompletionUsage

    bare = SimpleNamespace(
        usage=CompletionUsage(prompt_tokens=7, completion_tokens=3, total_tokens=10), model="m"
    )
    assert usage_of(bare).as_json() == {  # type: ignore[arg-type]
        "input": 7, "output": 3, "cached": 0, "reasoning": 0, "models": ["m"],
    }  # fmt: skip
    assert usage_of(SimpleNamespace(usage=None, model="m")).as_json()["input"] == 0  # type: ignore[arg-type]


def test_postings_still_waiting_at_the_budget_are_given_up_on():
    import threading

    release = threading.Event()

    def answer(**_):
        release.wait(5)
        return PYTHON_ROLE

    # One worker: the first is running at the budget, the others are still queued.
    out = extract_all([INDEED] * 4, extractor(answer), concurrency=1, budget=0.05)
    release.set()
    assert out.results == [None] * 4 and out.unfinished == 4


class Credential:
    def get_token(self, *scopes, **kwargs):
        raise AssertionError("no call is made while building the client")


ENV = {
    "MODEL_ENDPOINT": "https://main.openai.azure.com",
    "MODEL_NAME": "main-deployment",
}


def test_the_extract_slot_takes_the_main_ones_name_unless_it_has_its_own():
    assert extractor_from_env(ENV, Credential()).model == "main-deployment"  # type: ignore[arg-type]
    own = extractor_from_env({**ENV, "MODEL_EXTRACT_NAME": "nano"}, Credential())  # type: ignore[arg-type]
    assert own.model == "nano"


def test_a_missing_setting_is_named():
    with pytest.raises(RuntimeError, match="MODEL_NAME"):
        extractor_from_env({"MODEL_ENDPOINT": "https://x"}, Credential())  # type: ignore[arg-type]
