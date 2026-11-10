"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ADDRESS_STATUS_COLORS,
  ADDRESS_STATUS_LABELS,
  type AddressStatus,
} from "@/lib/address-status";
import { defaultPeriodKey, periodKey, type ReportingPeriod } from "@/lib/outreach-period";
import { GoogleOutreachMap, StatusLegend } from "@/components/google-outreach-map";
import type { MapAddressPoint, MapAddressSummary } from "@/lib/map-data";

interface OutreachWorkspaceProps {
  suburbs: readonly string[];
}

interface MapData {
  points: MapAddressPoint[];
  summary: MapAddressSummary;
}

type StatusFilter = "all" | AddressStatus;
type ViewMode = "overview" | "map";

const STATUS_FILTERS: StatusFilter[] = ["all", "unsent", "sent", "junk"];

function statusFilterLabel(status: StatusFilter) {
  return status === "all" ? "All" : ADDRESS_STATUS_LABELS[status];
}

export function OutreachWorkspace({ suburbs }: OutreachWorkspaceProps) {
  const defaultSuburb = suburbs.find((suburb) => suburb.toLowerCase() === "albany") ?? null;
  const [selectedSuburb, setSelectedSuburb] = useState<string | null>(defaultSuburb);
  const [periods, setPeriods] = useState<ReportingPeriod[]>([]);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState("2026:Q3");
  const [periodsLoading, setPeriodsLoading] = useState(Boolean(defaultSuburb));
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [mapData, setMapData] = useState<MapData | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const quarterController = useRef<AbortController | null>(null);
  const apiKey =
    process.env.NEXT_PUBLIC_SMARTROUTE_GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ??
    "";

  const selectedPeriod = periods.find((period) => periodKey(period) === selectedPeriodKey) ?? null;
  const selectedYear = selectedPeriod?.year ?? null;
  const selectedQuarter = selectedPeriod?.quarter ?? null;

  async function chooseSuburb(suburb: string) {
    setSelectedSuburb(suburb);
    setViewMode("map");
    setMapData(null);
    setMapError(null);
    setPeriods([]);
    setSelectedPeriodKey("2026:Q3");
    setPeriodsError(null);
    setPeriodsLoading(true);
  }

  useEffect(() => {
    if (!selectedSuburb) return;
    const suburb = selectedSuburb;

    quarterController.current?.abort();
    const controller = new AbortController();
    quarterController.current = controller;

    async function loadPeriods() {
      try {
        const response = await fetch(
          `/api/admin/outreach/quarters?suburb=${encodeURIComponent(suburb)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const payload = (await response.json()) as {
          periods?: ReportingPeriod[];
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Reporting periods could not be loaded.");
        }

        const nextPeriods = payload.periods ?? [];
        setPeriods(nextPeriods);
        setSelectedPeriodKey(defaultPeriodKey(nextPeriods));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPeriodsError(
          error instanceof Error ? error.message : "Reporting periods could not be loaded.",
        );
      } finally {
        if (!controller.signal.aborted) setPeriodsLoading(false);
      }
    }

    void loadPeriods();
    return () => controller.abort();
  }, [selectedSuburb]);

  useEffect(() => {
    if (periodsLoading || viewMode !== "map" || !selectedSuburb) return;
    const controller = new AbortController();
    let active = true;

    async function loadMap() {
      setMapLoading(true);
      setMapError(null);
      setMapData(null);

      try {
        const query = new URLSearchParams({ suburb: selectedSuburb! });
        if (selectedYear !== null && selectedQuarter !== null) {
          query.set("year", String(selectedYear));
          query.set("quarter", selectedQuarter);
        }

        const response = await fetch(`/api/admin/outreach/map?${query}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = (await response.json()) as MapData & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Map data could not be loaded.");
        }
        if (active) setMapData(payload);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (active) {
          setMapError(error instanceof Error ? error.message : "Map data could not be loaded.");
        }
      } finally {
        if (active) setMapLoading(false);
      }
    }

    void loadMap();
    return () => {
      active = false;
      controller.abort();
    };
  }, [periodsLoading, viewMode, selectedSuburb, selectedYear, selectedQuarter]);

  const visiblePoints = useMemo(
    () =>
      (mapData?.points ?? []).filter(
        (point) => statusFilter === "all" || point.status === statusFilter,
      ),
    [mapData?.points, statusFilter],
  );

  return (
    <section className="outreach-workspace" aria-label="Outreach map workspace">
      <div className="suburb-filter-panel">
        <div className="filter-heading">
          <div>
            <h2>Quick Filter by Suburb</h2>
            <p className="muted">Auckland North Shore</p>
          </div>
          <span className="suburb-count">{suburbs.length} suburbs</span>
        </div>
        <div className="suburb-chips">
          {suburbs.map((suburb) => (
            <button
              key={suburb}
              type="button"
              className={selectedSuburb === suburb ? "suburb-chip selected" : "suburb-chip"}
              aria-pressed={selectedSuburb === suburb}
              onClick={() => void chooseSuburb(suburb)}
            >
              {suburb}
            </button>
          ))}
        </div>
      </div>

      <div className="map-toolbar">
        <div className="selection-summary" aria-live="polite">
          {selectedSuburb ? (
            <>
              <span className="selection-label">Selected suburb</span>
              <strong>{selectedSuburb}</strong>
            </>
          ) : (
            <span className="muted">Select a suburb to begin.</span>
          )}
        </div>
        <div className="toolbar-controls">
          <label className="period-control">
            <span>Reporting period</span>
            <select
              value={selectedPeriodKey}
              disabled={!selectedSuburb || periodsLoading}
              onChange={(event) => {
                setSelectedPeriodKey(event.target.value);
                setMapData(null);
              }}
            >
              <option value="all">All history</option>
              {periods.map((period) => (
                <option key={periodKey(period)} value={periodKey(period)}>
                  {period.quarter} {period.year}
                </option>
              ))}
            </select>
          </label>
          <div className="view-tabs" role="tablist" aria-label="Outreach view">
            <button
              className={viewMode === "map" ? "view-tab selected" : "view-tab"}
              type="button"
              role="tab"
              aria-selected={viewMode === "map"}
              disabled={!selectedSuburb}
              onClick={() => setViewMode("map")}
            >
              Map
            </button>
            <button className="view-tab" type="button" disabled title="Cards are planned for a later milestone">
              Cards
            </button>
            <button className="view-tab" type="button" disabled title="List is planned for a later milestone">
              List
            </button>
          </div>
        </div>
      </div>

      {periodsError ? <p className="notice notice-error">{periodsError}</p> : null}
      {periodsLoading ? <p className="inline-status">Loading reporting periods…</p> : null}

      {viewMode === "map" && selectedSuburb ? (
        <section className="map-section" aria-label={`${selectedSuburb} address map`}>
          <div className="map-summary-bar">
            <div className="map-status-filters" aria-label="Filter map by dispatch status">
              {STATUS_FILTERS.map((status) => {
                const count =
                  status === "all"
                    ? mapData?.summary.total
                    : mapData?.summary.states[status];
                return (
                  <button
                    key={status}
                    type="button"
                    className={statusFilter === status ? "status-filter active" : "status-filter"}
                    aria-pressed={statusFilter === status}
                    onClick={() => setStatusFilter(status)}
                  >
                    {status !== "all" ? (
                      <span
                        className="legend-dot"
                        style={{ backgroundColor: ADDRESS_STATUS_COLORS[status] }}
                        aria-hidden="true"
                      />
                    ) : null}
                    {statusFilterLabel(status)}
                    <span className="filter-count">{count ?? "—"}</span>
                  </button>
                );
              })}
            </div>
            <div className="map-summary-counts" aria-live="polite">
              {mapData ? (
                <>
                  <span>{mapData.summary.mapped.toLocaleString()} mapped</span>
                  <span className="summary-separator">·</span>
                  <span>{mapData.summary.missingCoordinates.toLocaleString()} without coordinates</span>
                </>
              ) : null}
            </div>
          </div>

          {periodsLoading || mapLoading ? (
            <div className="map-message" role="status">
              {periodsLoading ? "Loading reporting periods…" : "Loading live Outreach locations…"}
            </div>
          ) : mapError ? (
            <div className="map-message map-error" role="alert">
              <strong>Map data unavailable</strong>
              <span>{mapError}</span>
            </div>
          ) : !apiKey ? (
            <div className="map-message map-error" role="alert">
              <strong>Google Maps is not configured</strong>
              <span>
                Add a browser key as NEXT_PUBLIC_SMARTROUTE_GOOGLE_MAPS_API_KEY or
                NEXT_PUBLIC_GOOGLE_MAPS_API_KEY.
              </span>
            </div>
          ) : mapData ? (
            <>
              <div className="map-canvas">
                <GoogleOutreachMap apiKey={apiKey} points={visiblePoints} />
              </div>
              <div className="map-footer">
                <div className="map-legend" aria-label="Address status legend">
                  <StatusLegend status="unsent" />
                  <StatusLegend status="sent" />
                  <StatusLegend status="junk" />
                </div>
                <span>
                  Showing {visiblePoints.length.toLocaleString()} of{" "}
                  {mapData.summary.mapped.toLocaleString()} mapped addresses
                </span>
              </div>
            </>
          ) : (
            <div className="map-message" role="status">
              No map results are available for this selection.
            </div>
          )}
        </section>
      ) : (
        <div className="map-message first-step-message">
          <div className="map-placeholder-icon" aria-hidden="true">
            ◎
          </div>
          <strong>{selectedSuburb ? `${selectedSuburb} is selected` : "Choose a suburb"}</strong>
          <span>
            {selectedSuburb
              ? "Select Map to load the real address markers and status colors."
              : "Select a North Shore suburb above, then open Map view."}
          </span>
        </div>
      )}
    </section>
  );
}
