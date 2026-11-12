"""One tracer provider for the whole test run, as the distro would register in Azure.

OpenTelemetry allows a single global provider per process, so it is set here once;
the in-memory exporter is OpenTelemetry's own, standing in for Application Insights.
"""

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from scanner.telemetry import instrument_openai

EXPORTER = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(EXPORTER))
trace.set_tracer_provider(_provider)
instrument_openai(_provider)


@pytest.fixture
def spans():
    """The spans a test ends, cleared before it starts."""
    EXPORTER.clear()
    yield EXPORTER
