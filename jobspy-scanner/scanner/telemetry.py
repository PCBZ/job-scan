"""OpenTelemetry for the scanner: its run and stages as spans, and each model call.

Exports to APPLICATIONINSIGHTS_CONNECTION_STRING, which Terraform sets, through
the Azure Monitor distro. Without it (tests, local runs) nothing is configured
and spans go nowhere.

The distro instruments HTTP clients by default. Those are off here: jobspy
scrapes through `requests`, and every search URL carries the target titles and
locations; the OpenAI client goes through `httpx2`, and OpenInference already
spans those calls.
Only this scanner's own logger is exported, never a library's: jobspy logs
the URLs it fetched. OpenInference hides prompts and answers, which hold
posting text. Span names follow the Node side ("node <stage>"), so the
evaluation's latency query finds them.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager

from opentelemetry import trace

LOGGER = "jobspy-scanner"
TRACER = "jobspy-scanner"

# The distro's instrumentations that would record request URLs or duplicate spans.
HTTP_CLIENTS = ("requests", "urllib", "urllib3", "httpx", "httpx2")


def configure(
    env: dict[str, str],
    configure_azure_monitor: Callable[..., None] | None = None,
) -> bool:
    """Export to Application Insights when the app has its connection string; True if it does."""
    if not env.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        return False
    if configure_azure_monitor is None:
        from azure.monitor.opentelemetry import configure_azure_monitor
    configure_azure_monitor(
        logger_name=LOGGER,
        instrumentation_options={name: {"enabled": False} for name in HTTP_CLIENTS},
    )
    instrument_openai()
    return True


def instrument_openai(tracer_provider: trace.TracerProvider | None = None) -> None:
    """A span for every OpenAI call: model, tokens and status, with no prompt or answer."""
    from openinference.instrumentation import TraceConfig
    from openinference.instrumentation.openai import OpenAIInstrumentor

    OpenAIInstrumentor().instrument(
        tracer_provider=tracer_provider or trace.get_tracer_provider(),
        config=TraceConfig(hide_inputs=True, hide_outputs=True),
    )


@contextmanager
def span(name: str) -> Iterator[trace.Span]:
    """A span current for the block; an exception marks it failed and goes on.

    Only the exception's type is recorded: its message can hold config values
    or posting text (a validation error quotes its input)."""
    tracer = trace.get_tracer(TRACER)
    with tracer.start_as_current_span(
        name, record_exception=False, set_status_on_exception=False
    ) as current:
        try:
            yield current
        except BaseException as err:
            kind = type(err).__name__
            current.add_event("exception", {"exception.type": kind})
            current.set_status(trace.Status(trace.StatusCode.ERROR, kind))
            raise


def trace_of(current: trace.Span) -> dict[str, str] | None:
    """Where the trace stands, for the handoff, so `collect` can link to it; None when not traced."""
    context = current.get_span_context()
    if not context.is_valid:
        return None
    return {
        "trace_id": trace.format_trace_id(context.trace_id),
        "span_id": trace.format_span_id(context.span_id),
    }
