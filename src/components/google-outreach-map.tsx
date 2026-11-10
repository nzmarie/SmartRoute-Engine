"use client";

/// <reference types="google.maps" />

import { useEffect, useState } from "react";
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map,
  useApiIsLoaded,
  useMap,
} from "@vis.gl/react-google-maps";
import {
  ADDRESS_STATUS_LABELS,
  type AddressStatus,
} from "@/lib/address-status";
import type { MapAddressPoint } from "@/lib/map-data";

interface GoogleOutreachMapProps {
  apiKey: string;
  points: MapAddressPoint[];
}

function FitMapToPoints({ points }: Pick<GoogleOutreachMapProps, "points">) {
  const map = useMap();

  useEffect(() => {
    if (!map || !points.length) return;

    let north = -90;
    let south = 90;
    let east = -180;
    let west = 180;
    for (const point of points) {
      north = Math.max(north, point.lat);
      south = Math.min(south, point.lat);
      east = Math.max(east, point.lng);
      west = Math.min(west, point.lng);
    }

    map.fitBounds({ north, south, east, west }, 48);
    if (points.length === 1) map.setZoom(15);
  }, [map, points]);

  return null;
}

function MapMarkers({ points }: Pick<GoogleOutreachMapProps, "points">) {
  const isLoaded = useApiIsLoaded();
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);
  const selectedPoint =
    points.find((point, index) => markerKey(point, index) === selectedPointKey) ?? null;

  if (!isLoaded) return null;

  return (
    <>
      {points.map((point, index) => (
        <AdvancedMarker
          key={markerKey(point, index)}
          position={{ lat: point.lat, lng: point.lng }}
          title={point.address}
          clickable
          anchorLeft="-50%"
          anchorTop="-50%"
          onClick={() => setSelectedPointKey(markerKey(point, index))}
          zIndex={point.status === "unsent" ? 3 : point.status === "sent" ? 2 : 1}
          className={`advanced-address-marker ${point.status}`}
        >
          <span aria-hidden="true" />
        </AdvancedMarker>
      ))}
      {selectedPoint ? (
        <InfoWindow
          position={{ lat: selectedPoint.lat, lng: selectedPoint.lng }}
          onCloseClick={() => setSelectedPointKey(null)}
        >
          <div className="address-info-window">
            <a
              className="address-info-link"
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedPoint.address)}`}
              target="_blank"
              rel="noreferrer"
            >
              {selectedPoint.address}
            </a>
            <span className="address-info-status">{ADDRESS_STATUS_LABELS[selectedPoint.status]}</span>
            <a
              className="address-info-directions"
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedPoint.address)}`}
              target="_blank"
              rel="noreferrer"
            >
              Google Maps ↗
            </a>
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

function markerKey(point: MapAddressPoint, index: number) {
  return `${point.address}:${point.lat}:${point.lng}:${point.status}:${index}`;
}

export function GoogleOutreachMap({ apiKey, points }: GoogleOutreachMapProps) {
  const [loadError, setLoadError] = useState(false);
  const mapId =
    process.env.NEXT_PUBLIC_SMARTROUTE_GOOGLE_MAPS_MAP_ID?.trim() ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim() ||
    "DEMO_MAP_ID";

  return (
    <APIProvider
      apiKey={apiKey}
      onLoad={() => setLoadError(false)}
      onError={() => setLoadError(true)}
    >
      {loadError ? (
        <div className="map-message map-error map-script-error" role="alert">
          <strong>Google Maps could not be loaded</strong>
          <span>
            Check the SmartRoute Maps key, enabled APIs, and allowed HTTP referrers, then retry.
          </span>
          <button className="retry-button" type="button" onClick={() => window.location.reload()}>
            Retry map
          </button>
        </div>
      ) : (
        <Map
          className="google-map"
          mapId={mapId}
          defaultCenter={{ lat: -36.731, lng: 174.705 }}
          defaultZoom={12}
          gestureHandling="greedy"
          mapTypeControl
          fullscreenControl
          streetViewControl={false}
          clickableIcons={false}
        >
          <FitMapToPoints points={points} />
          <MapMarkers points={points} />
        </Map>
      )}
    </APIProvider>
  );
}

export function StatusLegend({ status }: { status: AddressStatus }) {
  return (
    <span className="legend-item">
      <span className={`legend-dot ${status}`} aria-hidden="true" />
      {ADDRESS_STATUS_LABELS[status]}
    </span>
  );
}
