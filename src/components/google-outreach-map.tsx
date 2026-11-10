"use client";

/// <reference types="google.maps" />

import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map,
  Polyline,
  useApiIsLoaded,
  useMapsLibrary,
  useMap,
} from "@vis.gl/react-google-maps";
import {
  ADDRESS_STATUS_LABELS,
  resolveSimulationDisplayStatus,
  type AddressStatus,
} from "@/lib/address-status";
import {
  advanceSimulationTime,
  buildDeliverySimulationPlan,
  buildStreetDeliveryPlan,
  chooseNearbyDeliveryCandidate,
  combineSimulationCyclePlans,
  getNearbyDeliveryCandidates,
  getWalkReturnRequests,
  getWalkingRouteChunks,
  getSimulationDuration,
  getSimulationFrame,
  getSimulationPlanningPoints,
  insertNearbyDeliveryIntoPlan,
  isNorthShoreGeocodeResult,
  MAX_NEARBY_DELIVERY_ADDITIONS,
  MAX_SIMULATION_CYCLES,
  MAX_SIMULATION_DELIVERIES,
  MAX_WALK_DURATION_MS,
  orderStreetsByRouteTime,
  selectSimulationCycleBatches,
  SIMULATION_CYCLE_DELAY_MS,
  type SimulationFrame,
  type SimulationRouteLeg,
  type StreetDeliveryPlan,
} from "@/lib/delivery-simulation";
import type { MapAddressPoint } from "@/lib/map-data";

interface GoogleOutreachMapProps {
  apiKey: string;
  points: MapAddressPoint[];
  simulationPoints: MapAddressPoint[];
  simulatedDeliveryAddressKeys: string[];
  onSimulatedDeliveryChange: (addressKeys: string[] | null) => void;
}

type PlaybackState = "idle" | "preparing" | "playing" | "paused" | "completed";

function FitMapToPoints({ points }: { points: { lat: number; lng: number }[] }) {
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

const MapMarkers = memo(function MapMarkers({
  points,
  simulationPoints,
  plannedAddresses,
  deliveredAddresses,
  activeAddressKey,
  junkStatusUnknown,
}: Pick<GoogleOutreachMapProps, "points" | "simulationPoints"> & {
  plannedAddresses: Set<string>;
  deliveredAddresses: Set<string>;
  activeAddressKey: string | null;
  junkStatusUnknown: boolean;
}) {
  const isLoaded = useApiIsLoaded();
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);
  const displayPoints = useMemo(() => {
    const displayedKeys = new Set(points.map(markerKey));
    const additions = simulationPoints.filter(
      (point) =>
        (plannedAddresses.has(point.addressKey) ||
          (junkStatusUnknown && point.status === "junk")) &&
        !displayedKeys.has(markerKey(point)),
    );
    return [...points, ...additions];
  }, [junkStatusUnknown, plannedAddresses, points, simulationPoints]);
  const selectedPoint =
    displayPoints.find((point) => markerKey(point) === selectedPointKey) ?? null;

  if (!isLoaded) return null;

  return (
    <>
      {displayPoints.map((point) => {
        const isDelivered = deliveredAddresses.has(point.addressKey);
        const displayStatus = resolveSimulationDisplayStatus(
          point.status,
          isDelivered,
          junkStatusUnknown,
        );
        const isActive = activeAddressKey === point.addressKey;
        const isPlanned = plannedAddresses.has(point.addressKey);
        return (
          <AdvancedMarker
            key={point.addressKey}
            position={{ lat: point.lat, lng: point.lng }}
            title={point.address}
            clickable
            anchorLeft="-50%"
            anchorTop="-50%"
            onClick={() => setSelectedPointKey(markerKey(point))}
            zIndex={isActive ? 50 : displayStatus === "unsent" ? 3 : displayStatus === "sent" ? 2 : 1}
            className={`advanced-address-marker ${displayStatus}${isPlanned ? " planned" : ""}${isActive ? " pulsing" : ""}`}
          >
            <span aria-hidden="true" />
          </AdvancedMarker>
        );
      })}
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
            <span className="address-info-status">
              {ADDRESS_STATUS_LABELS[
                resolveSimulationDisplayStatus(
                  selectedPoint.status,
                  deliveredAddresses.has(selectedPoint.addressKey),
                  junkStatusUnknown,
                )
              ]}
              {deliveredAddresses.has(selectedPoint.addressKey) &&
              (selectedPoint.status === "unsent" ||
                (junkStatusUnknown && selectedPoint.status === "junk"))
                ? " (simulation only)"
                : ""}
            </span>
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
});

function markerKey(point: MapAddressPoint) {
  return point.addressKey;
}

function toSimulationRouteLeg(
  leg:
    | {
        path: { lat: number; lng: number }[];
        durationMillis: number | null | undefined;
        distanceMeters: number | undefined;
      }
    | undefined,
): SimulationRouteLeg {
  if (
    !leg ||
    !Array.isArray(leg.path) ||
    leg.path.length === 0 ||
    leg.durationMillis == null ||
    !Number.isFinite(leg.durationMillis) ||
    leg.distanceMeters === undefined ||
    !Number.isFinite(leg.distanceMeters)
  ) {
    throw new Error("Google Maps did not return route distance and duration.");
  }

  return {
    path: leg.path.map(({ lat, lng }) => ({ lat, lng })),
    durationMs: leg.durationMillis,
    distanceMeters: leg.distanceMeters,
  };
}

function SimulationControls({
  points,
  simulationPoints,
  simulatedDeliveryAddressKeys,
  onSimulatedDeliveryChange,
}: Pick<
  GoogleOutreachMapProps,
  | "points"
  | "simulationPoints"
  | "simulatedDeliveryAddressKeys"
  | "onSimulatedDeliveryChange"
>) {
  const isLoaded = useApiIsLoaded();
  const geocodingLibrary = useMapsLibrary("geocoding");
  const routesLibrary = useMapsLibrary("routes");
  const map = useMap();
  const [startAddress, setStartAddress] = useState("");
  const [speed, setSpeed] = useState(50);
  const [deliveryCount, setDeliveryCount] = useState("50");
  const [cycleCount, setCycleCount] = useState("1");
  const [junkStatusUnknown, setJunkStatusUnknown] = useState(false);
  const [showRoute, setShowRoute] = useState(true);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [plan, setPlan] = useState<StreetDeliveryPlan | null>(null);
  const [plannedCycleCount, setPlannedCycleCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isCheckingNearby, setIsCheckingNearby] = useState(false);
  const [nearbyAddedCount, setNearbyAddedCount] = useState(0);
  const elapsedRef = useRef(0);
  const reportedAddressKeysRef = useRef(new Set(simulatedDeliveryAddressKeys));
  const nearbyCheckedAddressKeysRef = useRef(new Set<string>());
  const nearbyAddedCountRef = useRef(0);
  const nearbyScanGenerationRef = useRef(0);
  const nearbyAdditionLimitRef = useRef(MAX_NEARBY_DELIVERY_ADDITIONS);
  const durationMs = plan ? getSimulationDuration(plan.steps) : 0;
  const planningPoints = useMemo(
    () => getSimulationPlanningPoints(simulationPoints, junkStatusUnknown),
    [junkStatusUnknown, simulationPoints],
  );
  const simulatedAddressKeys = useMemo(
    () => new Set(simulatedDeliveryAddressKeys),
    [simulatedDeliveryAddressKeys],
  );
  const eligibleAddressCount = planningPoints.filter(
    ({ addressKey, status }) => status === "unsent" && !simulatedAddressKeys.has(addressKey),
  ).length;
  const maxDeliveries = Math.min(MAX_SIMULATION_DELIVERIES, eligibleAddressCount);
  const eligibleAddressLabel = junkStatusUnknown ? "Unsent or unknown Junk mail" : "Unsent";
  const parsedDeliveryCount = Number(deliveryCount);
  const normalizedDeliveryCount =
    maxDeliveries === 0 || !deliveryCount.trim()
      ? ""
      : Number.isFinite(parsedDeliveryCount)
        ? String(Math.min(parsedDeliveryCount, maxDeliveries))
        : deliveryCount;
  const requestedCount = Number(normalizedDeliveryCount);
  const isDeliveryCountValid =
    Number.isInteger(requestedCount) && requestedCount >= 1 && requestedCount <= maxDeliveries;
  const parsedCycleCount = Number(cycleCount);
  const isCycleCountValid =
    Number.isInteger(parsedCycleCount) &&
    parsedCycleCount >= 1 &&
    parsedCycleCount <= MAX_SIMULATION_CYCLES;
  const frame: SimulationFrame | null = plan
    ? getSimulationFrame(plan.steps, elapsedMs)
    : null;
  const deliveredAddressKey = (frame?.deliveredAddresses ?? []).join("\u0000");
  const deliveredAddresses = useMemo(
    () =>
      new Set([
        ...simulatedDeliveryAddressKeys,
        ...(deliveredAddressKey ? deliveredAddressKey.split("\u0000") : []),
      ]),
    [deliveredAddressKey, simulatedDeliveryAddressKeys],
  );
  const plannedAddresses = useMemo(
    () => new Set(plan?.deliveries.map(({ addressKey }) => addressKey) ?? []),
    [plan],
  );
  const deliveredCount = frame?.deliveredAddresses.length ?? 0;
  const nextDelivery = plan?.deliveries[deliveredCount] ?? null;

  useEffect(() => {
    reportedAddressKeysRef.current = new Set(simulatedDeliveryAddressKeys);
  }, [simulatedDeliveryAddressKeys]);
  useEffect(() => {
    if (!plan || !deliveredAddressKey) return;

    const newAddressKeys = deliveredAddressKey
      .split("\u0000")
      .filter((addressKey) => !reportedAddressKeysRef.current.has(addressKey));
    if (!newAddressKeys.length) return;

    for (const addressKey of newAddressKeys) {
      reportedAddressKeysRef.current.add(addressKey);
    }
    onSimulatedDeliveryChange([...reportedAddressKeysRef.current]);
  }, [deliveredAddressKey, onSimulatedDeliveryChange, plan]);

  useEffect(() => {
    if (
      playbackState !== "playing" ||
      !plan ||
      (frame?.kind !== "walk" && frame?.kind !== "walk-return") ||
      deliveredCount === 0 ||
      deliveredCount > plan.deliveries.length ||
      nearbyAddedCountRef.current >= nearbyAdditionLimitRef.current ||
      !routesLibrary
    ) {
      return;
    }

    const completedDelivery = plan.deliveries[deliveredCount - 1]!;
    const nextDelivery = plan.deliveries[deliveredCount];
    if (nearbyCheckedAddressKeysRef.current.has(completedDelivery.addressKey)) return;
    nearbyCheckedAddressKeysRef.current.add(completedDelivery.addressKey);

    const candidates = getNearbyDeliveryCandidates(
      frame.position,
      planningPoints,
      new Set([
        ...plan.deliveries.map(({ addressKey }) => addressKey),
        ...simulatedAddressKeys,
      ]),
    );
    if (!candidates.length) return;

    const generation = nearbyScanGenerationRef.current;
    const origin = frame.position;
    const destination =
      frame.kind === "walk"
        ? nextDelivery
          ? { lat: nextDelivery.lat, lng: nextDelivery.lng }
          : null
        : frame.parkedPosition;
    if (!destination) return;
    const candidateLocations = candidates.map(({ lat, lng }) => ({ lat, lng }));

    void (async () => {
      setError(null);
      setPlaybackState("paused");
      setIsCheckingNearby(true);
      try {
        const [fromOriginResult, toNextMatrixResult] = await Promise.all([
          routesLibrary.RouteMatrix.computeRouteMatrix({
            origins: [origin],
            destinations: [...candidateLocations, destination],
            travelMode: "WALKING",
            fields: ["condition", "durationMillis"],
          }),
          routesLibrary.RouteMatrix.computeRouteMatrix({
            origins: candidateLocations,
            destinations: [destination],
            travelMode: "WALKING",
            fields: ["condition", "durationMillis"],
          }),
        ]);
        if (generation !== nearbyScanGenerationRef.current) return;

        const fromOriginRows: Array<{
          items: Array<{
            condition?: string | null;
            durationMillis?: number | null;
          }>;
        }> = fromOriginResult.matrix.rows;
        const toNextRows: Array<{
          items: Array<{
            condition?: string | null;
            durationMillis?: number | null;
          }>;
        }> = toNextMatrixResult.matrix.rows;
        if (
          fromOriginRows.length !== 1 ||
          fromOriginRows[0]!.items.length !== candidates.length + 1 ||
          toNextRows.length !== candidates.length ||
          toNextRows.some((row) => row.items.length !== 1)
        ) {
          throw new Error("Google Maps returned incomplete nearby walking route durations.");
        }
        const duration = (item: {
          condition?: string | null;
          durationMillis?: number | null;
        }) => {
          return item.condition === "ROUTE_EXISTS" ? item.durationMillis ?? null : null;
        };
        const baselineDurationMs = duration(fromOriginRows[0]!.items[candidates.length]!);
        const candidate = chooseNearbyDeliveryCandidate(
          candidates,
          candidates.map((_, index) => duration(fromOriginRows[0]!.items[index]!)),
          toNextRows.map((row) => duration(row.items[0]!)),
          baselineDurationMs,
        );
        if (!candidate) return;

        const [toCandidateResult, toNextResult] = await Promise.all([
          routesLibrary.Route.computeRoutes({
            origin,
            destination: { lat: candidate.point.lat, lng: candidate.point.lng },
            travelMode: "WALKING",
            polylineQuality: "HIGH_QUALITY",
            fields: ["path", "legs"],
          }),
          routesLibrary.Route.computeRoutes({
            origin: { lat: candidate.point.lat, lng: candidate.point.lng },
            destination,
            travelMode: "WALKING",
            polylineQuality: "HIGH_QUALITY",
            fields: ["path", "legs"],
          }),
        ]);
        if (generation !== nearbyScanGenerationRef.current) return;

        const fromOriginLeg = toSimulationRouteLeg(
          toCandidateResult.routes?.[0]?.legs?.[0],
        );
        const toNextLeg = toSimulationRouteLeg(toNextResult.routes?.[0]?.legs?.[0]);
        if (
          !chooseNearbyDeliveryCandidate(
            [candidate.point],
            [fromOriginLeg.durationMs],
            [toNextLeg.durationMs],
            baselineDurationMs,
          )
        ) {
          return;
        }
        let currentStepIndex = -1;
        let stepStart = 0;
        let accumulatedDuration = 0;
        for (let index = 0; index < plan.steps.length; index += 1) {
          const step = plan.steps[index]!;
          if (
            elapsedMs >= accumulatedDuration &&
            elapsedMs < accumulatedDuration + step.durationMs &&
            step.kind === frame.kind
          ) {
            currentStepIndex = index;
            stepStart = accumulatedDuration;
            break;
          }
          accumulatedDuration += step.durationMs;
        }
        if (currentStepIndex < 0) {
          throw new Error("The current walking segment changed before nearby planning completed.");
        }
        const updatedPlan = insertNearbyDeliveryIntoPlan(
          plan,
          deliveredCount,
          currentStepIndex,
          candidate.point,
          origin,
          fromOriginLeg,
          toNextLeg,
        );
        elapsedRef.current = stepStart;
        setElapsedMs(stepStart);
        setPlan(updatedPlan);
        nearbyAddedCountRef.current += 1;
        setNearbyAddedCount(nearbyAddedCountRef.current);
      } catch (nearbyError) {
        if (generation === nearbyScanGenerationRef.current) {
          setError(
            `Nearby address check failed; continuing the planned route. ${
              nearbyError instanceof Error ? nearbyError.message : "Unknown route error."
            }`,
          );
        }
      } finally {
        if (generation === nearbyScanGenerationRef.current) {
          setIsCheckingNearby(false);
          setPlaybackState("playing");
        }
      }
    })();
  }, [
    deliveredCount,
    elapsedMs,
    frame,
    plan,
    playbackState,
    planningPoints,
    routesLibrary,
    simulatedAddressKeys,
  ]);

  useEffect(() => {
    if (playbackState !== "playing" || !plan) return;

    let animationFrame = 0;
    let previousTimestamp: number | null = null;
    const animate = (timestamp: number) => {
      if (previousTimestamp !== null) {
        elapsedRef.current = advanceSimulationTime(
          plan.steps,
          elapsedRef.current,
          timestamp - previousTimestamp,
          speed,
        );
        setElapsedMs(elapsedRef.current);
        if (elapsedRef.current >= durationMs) {
          setPlaybackState("completed");
          return;
        }
      }

      previousTimestamp = timestamp;
      animationFrame = window.requestAnimationFrame(animate);
    };

    animationFrame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [durationMs, plan, playbackState, speed]);

  async function startSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || !geocodingLibrary || !routesLibrary || !startAddress.trim()) return;

    setError(null);
    nearbyScanGenerationRef.current += 1;
    setIsCheckingNearby(false);
    setNearbyAddedCount(0);
    nearbyAddedCountRef.current = 0;
    nearbyCheckedAddressKeysRef.current.clear();
    setPlan(null);
    elapsedRef.current = 0;
    setElapsedMs(0);
    setPlaybackState("preparing");
    try {
      const { results } = await new geocodingLibrary.Geocoder().geocode({
        address: startAddress.trim(),
        componentRestrictions: { country: "NZ" },
      });
      const result = results[0];
      if (!result) throw new Error("Google Maps could not find that starting address.");

      const addressParts = [
        result.formatted_address,
        ...result.address_components.flatMap(
          (component: { long_name: string; short_name: string }) => [
            component.long_name,
            component.short_name,
          ],
        ),
      ];
      if (!isNorthShoreGeocodeResult(addressParts)) {
        throw new Error("Enter a starting address in an Auckland North Shore suburb.");
      }

      const start = result.geometry.location.toJSON();
      if (!isDeliveryCountValid) {
        throw new Error(`Choose between 1 and ${maxDeliveries} eligible addresses.`);
      }
      if (!isCycleCountValid) {
        throw new Error(`Choose between 1 and ${MAX_SIMULATION_CYCLES} runs.`);
      }

      const cycleBatches = selectSimulationCycleBatches(
        start,
        planningPoints,
        requestedCount,
        parsedCycleCount,
        simulatedAddressKeys,
      );
      if (!cycleBatches.length) {
        throw new Error("No mapped eligible addresses remain for this simulation.");
      }

      const routedCycles: StreetDeliveryPlan[] = [];
      for (const batch of cycleBatches) {
        const selectedPlan: StreetDeliveryPlan = {
          start,
          deliveries: batch,
          drivingStopAddressKeys: [],
          drivingPaths: [],
          walkingPaths: [],
          returnDrivePath: [],
          totalDistanceMeters: 0,
          steps: [],
        };
        const streetOrder = await orderStreetsByRouteTime(
          start,
          selectedPlan.deliveries,
          async (origin, destinations, travelMode) => {
            const { matrix } = await routesLibrary.RouteMatrix.computeRouteMatrix({
              origins: [origin],
              destinations,
              travelMode,
              fields: ["condition", "durationMillis"],
            });
            const items = matrix.rows[0]?.items ?? [];
            if (items.length !== destinations.length) {
              throw new Error("Google Maps returned incomplete street route durations.");
            }
            return items.map(
              (item: {
                condition?: string | null;
                durationMillis?: number | null;
              }) =>
              item.condition === "ROUTE_EXISTS" ? item.durationMillis ?? null : null,
            );
          },
        );
        const deliveryPlan = {
          ...selectedPlan,
          deliveries: streetOrder.deliveries,
          drivingStopAddressKeys: streetOrder.drivingStopAddressKeys,
        };
        const firstDelivery = deliveryPlan.deliveries[0]!;
        const driveOutResult = await routesLibrary.Route.computeRoutes({
          origin: start,
          destination: { lat: firstDelivery.lat, lng: firstDelivery.lng },
          travelMode: "DRIVING",
          polylineQuality: "HIGH_QUALITY",
          fields: ["path", "legs"],
        });
        const driveOutLeg = toSimulationRouteLeg(driveOutResult.routes?.[0]?.legs?.[0]);
        const drivingStopAddressKeys = new Set(deliveryPlan.drivingStopAddressKeys);
        const walkingLegs: Array<SimulationRouteLeg | null> = Array.from(
          { length: deliveryPlan.deliveries.length - 1 },
          () => null,
        );
        for (const chunk of getWalkingRouteChunks(
          deliveryPlan.deliveries,
          drivingStopAddressKeys,
        )) {
          const walkingResult = await routesLibrary.Route.computeRoutes({
            origin: { lat: chunk.origin.lat, lng: chunk.origin.lng },
            destination: { lat: chunk.destination.lat, lng: chunk.destination.lng },
            intermediates: chunk.intermediates.map(({ lat, lng }) => ({
              location: { lat, lng },
            })),
            travelMode: "WALKING",
            optimizeWaypointOrder: false,
            polylineQuality: "HIGH_QUALITY",
            fields: ["path", "legs"],
          });
          const routeLegs = walkingResult.routes?.[0]?.legs;
          if (!routeLegs?.length) {
            throw new Error("Google Maps could not calculate walking routes for the selected addresses.");
          }
          const expectedLegCount = chunk.intermediates.length + 1;
          if (routeLegs.length !== expectedLegCount) {
            throw new Error("Google Maps returned an incomplete walking route for the selected addresses.");
          }
          for (let index = 0; index < routeLegs.length; index += 1) {
            walkingLegs[chunk.startIndex + index] = toSimulationRouteLeg(routeLegs[index]);
          }
        }

        const longDriveLegs = new globalThis.Map<number, SimulationRouteLeg>();
        let parking = { lat: firstDelivery.lat, lng: firstDelivery.lng };
        for (let index = 0; index < walkingLegs.length; index += 1) {
          const nextDelivery = deliveryPlan.deliveries[index + 1]!;
          const walkingLeg = walkingLegs[index];
          if (
            !drivingStopAddressKeys.has(nextDelivery.addressKey) &&
            (!walkingLeg || walkingLeg.durationMs <= MAX_WALK_DURATION_MS)
          ) {
            continue;
          }

          const driveResult = await routesLibrary.Route.computeRoutes({
            origin: parking,
            destination: { lat: nextDelivery.lat, lng: nextDelivery.lng },
            travelMode: "DRIVING",
            polylineQuality: "HIGH_QUALITY",
            fields: ["path", "legs"],
          });
          longDriveLegs.set(
            index,
            toSimulationRouteLeg(driveResult.routes?.[0]?.legs?.[0]),
          );
          parking = { lat: nextDelivery.lat, lng: nextDelivery.lng };
        }

        const walkReturnLegs = new globalThis.Map<number, SimulationRouteLeg>();
        for (const request of getWalkReturnRequests(
          deliveryPlan.deliveries,
          walkingLegs,
          drivingStopAddressKeys,
        )) {
          const returnResult = await routesLibrary.Route.computeRoutes({
            origin: request.origin,
            destination: request.destination,
            travelMode: "WALKING",
            polylineQuality: "HIGH_QUALITY",
            fields: ["path", "legs"],
          });
          const returnLeg = returnResult.routes?.[0]?.legs?.[0];
          if (!returnLeg) {
            throw new Error("Google Maps could not calculate a direct walking route back to the marked parking point.");
          }
          walkReturnLegs.set(
            request.afterDeliveryIndex,
            toSimulationRouteLeg(returnLeg),
          );
        }

        const driveHomeResult = await routesLibrary.Route.computeRoutes({
          origin: parking,
          destination: start,
          travelMode: "DRIVING",
          polylineQuality: "HIGH_QUALITY",
          fields: ["path", "legs"],
        });
        const driveHomeLeg = toSimulationRouteLeg(driveHomeResult.routes?.[0]?.legs?.[0]);
        routedCycles.push(
          buildDeliverySimulationPlan(
            deliveryPlan,
            driveOutLeg,
            walkingLegs,
            longDriveLegs,
            walkReturnLegs,
            driveHomeLeg,
          ),
        );
      }

      const nextPlan = combineSimulationCyclePlans(routedCycles);
      nearbyAdditionLimitRef.current = MAX_NEARBY_DELIVERY_ADDITIONS * routedCycles.length;
      setPlannedCycleCount(routedCycles.length);
      setPlan(nextPlan);
      elapsedRef.current = 0;
      setElapsedMs(0);
      setPlaybackState("playing");
      if (map) {
        const locations = [
          start,
          ...nextPlan.drivingPaths.flat(),
          ...nextPlan.walkingPaths.flat(),
          ...nextPlan.returnDrivePath,
        ];
        map.fitBounds(
          {
            north: Math.max(...locations.map(({ lat }) => lat)),
            south: Math.min(...locations.map(({ lat }) => lat)),
            east: Math.max(...locations.map(({ lng }) => lng)),
            west: Math.min(...locations.map(({ lng }) => lng)),
          },
          72,
        );
      }
    } catch (simulationError) {
      setPlaybackState("idle");
      setError(
        simulationError instanceof Error
          ? simulationError.message
          : "The simulation could not be started.",
      );
    }
  }

  function resetSimulation() {
    nearbyScanGenerationRef.current += 1;
    elapsedRef.current = 0;
    setElapsedMs(0);
    setPlan(null);
    setPlannedCycleCount(0);
    setPlaybackState("idle");
    setError(null);
    setIsCheckingNearby(false);
    setNearbyAddedCount(0);
    nearbyAddedCountRef.current = 0;
    nearbyCheckedAddressKeysRef.current.clear();
    reportedAddressKeysRef.current.clear();
    onSimulatedDeliveryChange(null);
  }

  const statusText: Record<PlaybackState, string> = {
    idle: "Ready",
    preparing: "Finding start address…",
    playing: "Simulation running",
    paused: "Paused",
    completed: "Simulation complete",
  };
  const progress = frame ? Math.round(frame.progress * 100) : 0;
  const activeAddress = frame?.address ?? null;
  const activeAddressKey = frame?.addressKey ?? null;

  return (
    <>
      <section className="simulation-panel" aria-label="Delivery simulation">
        <div className="simulation-heading">
          <div>
            <h2>Delivery simulation</h2>
            <p>
              Choose a target of up to 50 Unsent addresses. Optionally treat Junk mail as unknown
              until simulated delivery. Complete each started street, even if that takes the total
              above your target; nearby eligible addresses may also be added on short, low-detour
              walks. Complete streets and nearby additions may increase the per-run target.
            </p>
          </div>
          <span className="simulation-badge">Demo only · no delivery data is changed</span>
        </div>
        <form className="simulation-form" onSubmit={(event) => void startSimulation(event)}>
          <label className="simulation-start-control">
            <span>Start address</span>
            <input
              value={startAddress}
              onChange={(event) => setStartAddress(event.target.value)}
              placeholder="e.g. 10 Tawa Drive, Albany, Auckland"
              autoComplete="street-address"
              required
              disabled={playbackState === "preparing"}
            />
          </label>
          <label className="simulation-speed-control">
            <span>Runs (max {MAX_SIMULATION_CYCLES})</span>
            <input
              type="number"
              min={1}
              max={MAX_SIMULATION_CYCLES}
              value={cycleCount}
              onChange={(event) => setCycleCount(event.target.value)}
              disabled={["preparing", "playing", "paused"].includes(playbackState)}
              required
            />
          </label>
          <label className="simulation-speed-control">
            <span>Target per run (max {maxDeliveries})</span>
            <input
              type="number"
              min={1}
              max={maxDeliveries}
              value={normalizedDeliveryCount}
              onChange={(event) => setDeliveryCount(event.target.value)}
              disabled={["preparing", "playing", "paused"].includes(playbackState) || maxDeliveries === 0}
              required
            />
          </label>
          <label className="simulation-speed-control">
            <span>Speed</span>
            <select
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              disabled={playbackState === "preparing"}
            >
              <option value={1}>1×</option>
              <option value={10}>10×</option>
              <option value={50}>50×</option>
            </select>
          </label>
          <label className="simulation-checkbox-control">
            <input
              type="checkbox"
              checked={junkStatusUnknown}
              onChange={(event) => setJunkStatusUnknown(event.target.checked)}
              disabled={["preparing", "playing", "paused"].includes(playbackState)}
            />
            <span>Junk status unknown</span>
          </label>
          <label className="simulation-checkbox-control route-visibility-control">
            <input
              type="checkbox"
              role="switch"
              checked={showRoute}
              onChange={(event) => setShowRoute(event.target.checked)}
              aria-label="Show route"
            />
            <span>Show route</span>
          </label>
          {playbackState === "playing" ? (
            <button
              className="simulation-button secondary"
              type="button"
              onClick={() => setPlaybackState("paused")}
            >
              Pause
            </button>
          ) : playbackState === "paused" ? (
            <button
              className="simulation-button"
              type="button"
              onClick={() => setPlaybackState("playing")}
              disabled={isCheckingNearby}
            >
              {isCheckingNearby ? "Checking nearby…" : "Resume"}
            </button>
          ) : (
            <button
              className="simulation-button"
              type="submit"
              disabled={
                !isLoaded ||
                !geocodingLibrary ||
                !routesLibrary ||
                playbackState === "preparing" ||
                !startAddress.trim() ||
                !isDeliveryCountValid ||
                !isCycleCountValid
              }
            >
              {playbackState === "preparing"
                ? "Preparing…"
                : playbackState === "completed" && simulatedDeliveryAddressKeys.length > 0
                  ? "Continue with remaining"
                  : "Start simulation"}
            </button>
          )}
          {plan ? (
            <button className="simulation-button secondary" type="button" onClick={resetSimulation}>
              Reset demo state
            </button>
          ) : null}
        </form>
        <div className="simulation-live-strip" aria-live="polite">
          {plan ? (
            <>
              <span>{(plan.totalDistanceMeters / 1_000).toFixed(1)} km on Google Maps routes</span>
              <span>{progress}%</span>
              <strong>
                {isCheckingNearby
                  ? "Checking nearby addresses…"
                  : frame?.kind === "cycle-wait"
                    ? "Waiting 10 seconds before the next run"
                    : activeAddress
                      ? `${frame?.delivering ? "Delivering at" : frame?.kind === "drive" ? "Driving to" : "Walking to"} ${activeAddress}`
                      : frame?.kind === "walk-return"
                        ? "Walking back to the marked parking point"
                        : frame?.kind === "board" && nextDelivery
                          ? `Boarding vehicle to ${nextDelivery.address}`
                          : frame?.kind === "drive-return"
                            ? "Driving back to start"
                            : statusText[playbackState]}
              </strong>
            </>
          ) : (
            <strong>
              {isCheckingNearby
                ? "Checking nearby walking routes…"
                : playbackState === "preparing"
                  ? "Finding Google Maps routes…"
                  : statusText[playbackState]}
            </strong>
          )}
        </div>
        <div
          className="simulation-progress-track"
          role="progressbar"
          aria-label="Simulation progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      </section>
      <Map
        className="google-map"
        mapId={
          process.env.NEXT_PUBLIC_SMARTROUTE_GOOGLE_MAPS_MAP_ID?.trim() ||
          process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim() ||
          "DEMO_MAP_ID"
        }
        defaultCenter={{ lat: -36.731, lng: 174.705 }}
        defaultZoom={12}
        gestureHandling="greedy"
        mapTypeControl
        fullscreenControl
        streetViewControl={false}
        clickableIcons={false}
      >
        <FitMapToPoints points={simulationPoints} />
        <MapMarkers
          points={points}
          simulationPoints={simulationPoints}
          plannedAddresses={plannedAddresses}
          deliveredAddresses={deliveredAddresses}
          activeAddressKey={activeAddressKey}
          junkStatusUnknown={junkStatusUnknown}
        />
        {plan ? (
          <>
            {showRoute ? (
              <>
                {plan.drivingPaths.map((path, index) => (
                  <Polyline
                    key={`drive-${index}`}
                    path={path}
                    options={{
                      strokeColor: "#2563eb",
                      strokeOpacity: 0.8,
                      strokeWeight: 5,
                      zIndex: 5,
                    }}
                  />
                ))}
                <Polyline
                  path={plan.returnDrivePath}
                  options={{
                    strokeColor: "#2563eb",
                    strokeOpacity: 0.8,
                    strokeWeight: 5,
                    zIndex: 5,
                  }}
                />
                {plan.walkingPaths.map((path, index) => (
                  <Polyline
                    key={`walk-${index}`}
                    path={path}
                    options={{
                      strokeColor: "#16a34a",
                      strokeOpacity: 0.8,
                      strokeWeight: 4,
                      zIndex: 4,
                    }}
                  />
                ))}
              </>
            ) : null}
            {frame ? (
              <>
                {!["drive", "drive-return", "complete"].includes(frame.kind) ? (
                  <AdvancedMarker
                    position={frame.parkedPosition}
                    title="Current parking point"
                    zIndex={10}
                    className="simulation-parking-marker"
                  >
                    <span aria-hidden="true">P</span>
                  </AdvancedMarker>
                ) : null}
                <AdvancedMarker
                  position={frame.carPosition}
                  title="Simulation car"
                  zIndex={20}
                  className="simulation-moving-marker car"
                >
                  <span
                    className="simulation-orientation"
                    style={{ transform: `rotate(${frame.carHeadingDegrees}deg)` }}
                    aria-hidden="true"
                  >
                    <svg className="simulation-car-icon" viewBox="0 0 40 48">
                      <path className="car-tire" d="M7 14h4v10H7zm22 0h4v10h-4zM7 30h4v10H7zm22 0h4v10h-4z" />
                      <path className="car-body" d="M12 5Q12 2 16 2h8q4 0 4 3l4 10v24q0 5-5 5H13q-5 0-5-5V15z" />
                      <path className="car-glass" d="M14 9q0-3 3-3h6q3 0 3 3l2 7H12z" />
                      <path className="car-glass" d="M12 30h16v7q0 3-3 3h-10q-3 0-3-3z" />
                      <path className="car-light" d="M9 10h3v5H9zm19 0h3v5h-3z" />
                      <path className="car-detail" d="M11 27h18m-14-1h10" />
                    </svg>
                  </span>
                </AdvancedMarker>
                {["walk", "deliver", "walk-return", "board"].includes(frame.kind) ? (
                  <AdvancedMarker
                    position={frame.position}
                    title="Simulation walker"
                    zIndex={21}
                    className={`simulation-moving-marker walker${["walk", "walk-return"].includes(frame.kind) ? " walking" : ""}`}
                  >
                    <span className="simulation-orientation" aria-hidden="true">
                      <svg className="simulation-walker-icon" viewBox="0 0 40 48">
                        <circle className="walker-head" cx="20" cy="7" r="5" />
                        <path className="walker-limb" d="M20 13v15m0-10-8 7m8-7 8 7" />
                        <path className="walker-limb walker-leg-a" d="M20 28 13 40" />
                        <path className="walker-limb walker-leg-b" d="M20 28 27 40" />
                      </svg>
                    </span>
                  </AdvancedMarker>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </Map>
      <details className="simulation-details">
        <summary>Simulation details and route status</summary>
        <div className="simulation-details-content">
          <div className="simulation-status" aria-live="polite">
            <strong>
              {isCheckingNearby
                ? "Checking nearby walking routes…"
                : playbackState === "preparing"
                  ? "Finding Google Maps routes…"
                  : statusText[playbackState]}
            </strong>
            <span>
              {eligibleAddressCount === 0
                ? `No mapped, not-yet-simulated ${eligibleAddressLabel} addresses are available.`
                : `${eligibleAddressCount} ${eligibleAddressLabel} addresses remain; choose a target up to ${maxDeliveries}. Previously simulated addresses are excluded.`}
            </span>
            {plan ? (
              <>
                <span>
                  {deliveredCount} / {plan.deliveries.length} delivered ·{" "}
                  {Math.max(0, plan.deliveries.length - deliveredCount)} planned remaining
                </span>
                <span>
                  {plannedCycleCount} run{plannedCycleCount === 1 ? "" : "s"} planned; each run
                  returns to the starting address and waits 10 seconds before the next.
                </span>
                <span>
                  Green rings mark addresses selected for this run. Streets are ordered using
                  Google Maps route-time estimates; addresses within a street use nearest-neighbor
                  ordering.
                </span>
                <span>
                  Each run checks up to 8 nearby eligible addresses within 250 m and may add up to{" "}
                  {MAX_NEARBY_DELIVERY_ADDITIONS} if walking legs are under 10 minutes and the
                  detour is at most 3 minutes. Complete streets can exceed the requested target.
                  Added nearby: {nearbyAddedCount}.
                </span>
                {frame?.kind === "walk-return" && nextDelivery ? (
                  <span>Next stop after boarding: {nextDelivery.address}</span>
                ) : null}
                {frame?.kind === "cycle-wait" ? (
                  <span>Next run starts from the saved starting address in 10 seconds.</span>
                ) : null}
              </>
            ) : null}
          </div>
          <p className="simulation-disclaimer">
            Route requests may incur Google Maps Platform charges. Delivery status changes exist
            only in this simulation; CRM, Sent, and Junk records remain unchanged.
          </p>
          {error ? (
            <p className="simulation-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </details>
    </>
  );
}

export function GoogleOutreachMap({
  apiKey,
  points,
  simulationPoints,
  simulatedDeliveryAddressKeys,
  onSimulatedDeliveryChange,
}: GoogleOutreachMapProps) {
  const [loadError, setLoadError] = useState(false);

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
        <div className="google-map-content">
          <SimulationControls
            points={points}
            simulationPoints={simulationPoints}
            simulatedDeliveryAddressKeys={simulatedDeliveryAddressKeys}
            onSimulatedDeliveryChange={onSimulatedDeliveryChange}
          />
        </div>
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
