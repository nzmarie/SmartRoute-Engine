import { NORTH_SHORE_SUBURBS } from "./north-shore-suburbs";
import type { MapAddressPoint } from "./map-address-results";

export interface SimulationLocation {
  lat: number;
  lng: number;
}

export interface NearbyDeliveryCandidate {
  point: MapAddressPoint;
  fromOriginDurationMs: number;
  toNextDurationMs: number;
}

export type SimulationStepKind =
  | "drive"
  | "park"
  | "board"
  | "walk"
  | "deliver"
  | "walk-return"
  | "cycle-wait"
  | "drive-return";

export interface SimulationRouteLeg {
  path: SimulationLocation[];
  durationMs: number;
  distanceMeters: number;
}

export type SimulationTravelMode = "WALKING" | "DRIVING";

export type RouteDurationLookup = (
  origin: SimulationLocation,
  destinations: SimulationLocation[],
  travelMode: SimulationTravelMode,
) => Promise<Array<number | null>>;

export interface SimulationStep {
  kind: SimulationStepKind;
  from: SimulationLocation;
  to: SimulationLocation;
  path: SimulationLocation[];
  durationMs: number;
  distanceMeters: number;
  parkingLocation: SimulationLocation;
  addressKey?: string;
  address?: string;
}

export interface StreetDeliveryPlan {
  start: SimulationLocation;
  deliveries: MapAddressPoint[];
  drivingStopAddressKeys: string[];
  drivingPaths: SimulationLocation[][];
  walkingPaths: SimulationLocation[][];
  returnDrivePath: SimulationLocation[];
  totalDistanceMeters: number;
  steps: SimulationStep[];
}

export interface OrderedStreetDeliveries {
  deliveries: MapAddressPoint[];
  drivingStopAddressKeys: string[];
}

export interface WalkReturnRequest {
  afterDeliveryIndex: number;
  origin: SimulationLocation;
  destination: SimulationLocation;
}

export interface SimulationFrame {
  kind: SimulationStepKind | "complete";
  position: SimulationLocation;
  carPosition: SimulationLocation;
  parkedPosition: SimulationLocation;
  carHeadingDegrees: number;
  addressKey: string | null;
  address: string | null;
  delivering: boolean;
  deliveredAddresses: string[];
  progress: number;
}

export const MAX_SIMULATION_DELIVERIES = 50;
export const MAX_SIMULATION_CYCLES = 10;
export const SIMULATION_CYCLE_DELAY_MS = 10_000;
export const MAX_WALK_DURATION_MS = 10 * 60 * 1_000;
export const MAX_NEARBY_DELIVERY_ADDITIONS = 5;
export const MAX_NEARBY_DELIVERY_CANDIDATES = 8;
export const NEARBY_DELIVERY_RADIUS_METERS = 250;
export const MAX_NEARBY_DELIVERY_DETOUR_MS = 3 * 60 * 1_000;

const MAX_ROUTE_INTERMEDIATES = 25;
const MAX_ROUTE_EDGES = MAX_ROUTE_INTERMEDIATES + 1;
const INITIAL_STOP_NEIGHBORHOOD_RADIUS_METERS =
  (MAX_WALK_DURATION_MS / 1_000) * (5_000 / 3_600);
const PARKING_DURATION_MS = 1_500;
const BOARDING_DURATION_MS = 1_000;
const DELIVERY_DURATION_MS = 15_000;

export function getSimulationPlanningPoints(
  points: MapAddressPoint[],
  junkStatusUnknown: boolean,
): MapAddressPoint[] {
  if (!junkStatusUnknown) return points;
  return points.map((point) =>
    point.status === "junk" ? { ...point, status: "unsent" } : point,
  );
}

export function isNorthShoreGeocodeResult(addressParts: string[]): boolean {
  const normalizedParts = addressParts.map(normalizeAddressPart);

  return NORTH_SHORE_SUBURBS.some((suburb) =>
    normalizedParts.includes(normalizeAddressPart(suburb)),
  );
}

export function buildStreetDeliveryPlan(
  start: SimulationLocation,
  points: MapAddressPoint[],
  requestedCount: number,
  excludedAddressKeys: ReadonlySet<string> = new Set(),
): StreetDeliveryPlan {
  if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > MAX_SIMULATION_DELIVERIES) {
    throw new Error(`Choose between 1 and ${MAX_SIMULATION_DELIVERIES} addresses.`);
  }

  const unsentPoints = points.filter(
    (point) =>
      point.status === "unsent" && !excludedAddressKeys.has(point.addressKey),
  );

  if (unsentPoints.length < requestedCount) {
    throw new Error(
      `Only ${unsentPoints.length} mapped Unsent addresses are available; ${requestedCount} were requested.`,
    );
  }

  const deliveries = selectNearestStreetFirst(start, unsentPoints, requestedCount);

  return {
    start,
    deliveries,
    drivingStopAddressKeys: [],
    drivingPaths: [],
    walkingPaths: [],
    returnDrivePath: [],
    totalDistanceMeters: 0,
    steps: [],
  };
}

export function selectSimulationCycleBatches(
  start: SimulationLocation,
  points: MapAddressPoint[],
  deliveriesPerCycle: number,
  cycleCount: number,
  excludedAddressKeys: ReadonlySet<string> = new Set(),
): MapAddressPoint[][] {
  if (
    !Number.isInteger(deliveriesPerCycle) ||
    deliveriesPerCycle < 1 ||
    deliveriesPerCycle > MAX_SIMULATION_DELIVERIES
  ) {
    throw new Error(`Choose between 1 and ${MAX_SIMULATION_DELIVERIES} addresses per run.`);
  }
  if (
    !Number.isInteger(cycleCount) ||
    cycleCount < 1 ||
    cycleCount > MAX_SIMULATION_CYCLES
  ) {
    throw new Error(`Choose between 1 and ${MAX_SIMULATION_CYCLES} runs.`);
  }

  const excluded = new Set(excludedAddressKeys);
  const batches: MapAddressPoint[][] = [];
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const remaining = points.filter(
      ({ addressKey, status }) => status === "unsent" && !excluded.has(addressKey),
    );
    if (!remaining.length) break;
    const count = Math.min(deliveriesPerCycle, remaining.length);
    const batch = buildStreetDeliveryPlan(start, points, count, excluded).deliveries;
    if (!batch.length) break;
    batches.push(batch);
    for (const { addressKey } of batch) excluded.add(addressKey);
  }
  return batches;
}

export function combineSimulationCyclePlans(
  plans: StreetDeliveryPlan[],
  delayMs = SIMULATION_CYCLE_DELAY_MS,
): StreetDeliveryPlan {
  if (!plans.length || !Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("At least one valid simulation cycle is required.");
  }

  const firstPlan = plans[0]!;
  const steps = plans.flatMap((plan, index) =>
    index === plans.length - 1
      ? plan.steps
      : [
          ...plan.steps,
          {
            kind: "cycle-wait" as const,
            from: plan.start,
            to: plan.start,
            path: [plan.start],
            durationMs: delayMs,
            distanceMeters: 0,
            parkingLocation: plan.start,
          },
        ],
  );
  const lastPlan = plans.at(-1)!;
  return {
    ...firstPlan,
    deliveries: plans.flatMap(({ deliveries }) => deliveries),
    drivingStopAddressKeys: plans.flatMap(({ drivingStopAddressKeys }) => drivingStopAddressKeys),
    drivingPaths: plans.flatMap(({ drivingPaths }) => drivingPaths),
    walkingPaths: plans.flatMap(({ walkingPaths }) => walkingPaths),
    returnDrivePath: lastPlan.returnDrivePath,
    totalDistanceMeters: plans.reduce((total, plan) => total + plan.totalDistanceMeters, 0),
    steps,
  };
}

export async function orderStreetsByRouteTime(
  start: SimulationLocation,
  deliveries: MapAddressPoint[],
  lookupDurations: RouteDurationLookup,
): Promise<OrderedStreetDeliveries> {
  const remaining = groupDeliveriesByStreet(deliveries);
  const ordered: MapAddressPoint[] = [];
  const drivingStopAddressKeys: string[] = [];
  let current = start;
  let firstStreet = true;

  while (remaining.length) {
    const remainingCandidates = remaining.map((group) => ({
      group,
      entry: orderStreetPoints(current, group.points)[0]!,
    }));
    const candidates = firstStreet ? remainingCandidates.slice(0, 1) : remainingCandidates;
    const destinations = candidates.map(({ entry }) => locationOf(entry));
    let selectedMode: SimulationTravelMode = firstStreet ? "DRIVING" : "WALKING";
    let durations = await lookupDurations(current, destinations, selectedMode);
    validateDurationResults(durations, candidates.length);

    let available = getAvailableStreetCandidates(
      candidates,
      durations,
      firstStreet,
    );

    if (!firstStreet && !available.some(({ durationMs }) => durationMs <= MAX_WALK_DURATION_MS)) {
      selectedMode = "DRIVING";
      durations = await lookupDurations(current, destinations, "DRIVING");
      validateDurationResults(durations, candidates.length);
      available = getAvailableStreetCandidates(candidates, durations, true);
    } else if (!firstStreet) {
      available = available.filter(({ durationMs }) => durationMs <= MAX_WALK_DURATION_MS);
    }

    available.sort(
      (left, right) =>
        left.durationMs - right.durationMs ||
        left.group.key.localeCompare(right.group.key),
    );
    const next = available[0];
    if (!next) {
      throw new Error(
        `Google Maps could not find a ${firstStreet ? "driving" : "driving or walkable"} route to any remaining street.`,
      );
    }

    const streetRoute = orderStreetPoints(locationOf(next.entry), next.group.points);
    if (selectedMode === "DRIVING" && !firstStreet) {
      drivingStopAddressKeys.push(streetRoute[0]!.addressKey);
    }
    ordered.push(...streetRoute);
    current = locationOf(streetRoute.at(-1)!);
    remaining.splice(
      remaining.findIndex(({ key }) => key === next.group.key),
      1,
    );
    firstStreet = false;
  }

  return { deliveries: ordered, drivingStopAddressKeys };
}

export function getWalkingRouteChunks(
  deliveries: MapAddressPoint[],
  drivingStopAddressKeys: ReadonlySet<string> = new Set(),
): Array<{
  startIndex: number;
  origin: MapAddressPoint;
  destination: MapAddressPoint;
  intermediates: MapAddressPoint[];
}> {
  const chunks = [];
  let firstPoint = 0;

  while (firstPoint < deliveries.length - 1) {
    let lastPoint = firstPoint;
    while (
      lastPoint < deliveries.length - 1 &&
      !drivingStopAddressKeys.has(deliveries[lastPoint + 1]!.addressKey)
    ) {
      lastPoint += 1;
    }

    for (let chunkStart = firstPoint; chunkStart < lastPoint; chunkStart += MAX_ROUTE_EDGES) {
      const chunkEnd = Math.min(chunkStart + MAX_ROUTE_EDGES, lastPoint);
      chunks.push({
        startIndex: chunkStart,
        origin: deliveries[chunkStart]!,
        destination: deliveries[chunkEnd]!,
        intermediates: deliveries.slice(chunkStart + 1, chunkEnd),
      });
    }
    firstPoint = lastPoint + 1;
  }

  return chunks;
}

export function getWalkReturnRequests(
  deliveries: MapAddressPoint[],
  walkingLegs: Array<SimulationRouteLeg | null>,
  drivingStopAddressKeys: ReadonlySet<string> = new Set(),
): WalkReturnRequest[] {
  const requests: WalkReturnRequest[] = [];
  let parking = locationOf(deliveries[0]!);
  let hasWalkedSinceParking = false;

  for (let index = 0; index < walkingLegs.length; index += 1) {
    const nextDelivery = deliveries[index + 1]!;
    const walkingLeg = walkingLegs[index];
    const shouldDrive =
      drivingStopAddressKeys.has(nextDelivery.addressKey) ||
      (walkingLeg !== null && walkingLeg !== undefined &&
        walkingLeg.durationMs > MAX_WALK_DURATION_MS);

    if (shouldDrive) {
      if (hasWalkedSinceParking) {
        requests.push({
          afterDeliveryIndex: index,
          origin: locationOf(deliveries[index]!),
          destination: parking,
        });
      }
      parking = locationOf(nextDelivery);
      hasWalkedSinceParking = false;
    } else if (walkingLeg) {
      hasWalkedSinceParking = true;
    }
  }

  if (hasWalkedSinceParking) {
    requests.push({
      afterDeliveryIndex: deliveries.length - 1,
      origin: locationOf(deliveries.at(-1)!),
      destination: parking,
    });
  }

  return requests;
}

export function getNearbyDeliveryCandidates(
  origin: SimulationLocation,
  points: MapAddressPoint[],
  excludedAddressKeys: ReadonlySet<string>,
): MapAddressPoint[] {
  return points
    .filter(
      (point) =>
        point.status === "unsent" &&
        !excludedAddressKeys.has(point.addressKey) &&
        distanceMeters(origin, point) <= NEARBY_DELIVERY_RADIUS_METERS,
    )
    .sort(
      (left, right) =>
        distanceMeters(origin, left) - distanceMeters(origin, right) ||
        left.addressKey.localeCompare(right.addressKey),
    )
    .slice(0, MAX_NEARBY_DELIVERY_CANDIDATES);
}

export function chooseNearbyDeliveryCandidate(
  candidates: MapAddressPoint[],
  fromOriginDurations: Array<number | null>,
  toNextDurations: Array<number | null>,
  baselineDurationMs: number | null,
): NearbyDeliveryCandidate | null {
  if (
    baselineDurationMs === null ||
    baselineDurationMs < 0 ||
    fromOriginDurations.length !== candidates.length ||
    toNextDurations.length !== candidates.length
  ) {
    return null;
  }

  return candidates
    .flatMap((point, index) => {
      const fromOriginDurationMs = fromOriginDurations[index];
      const toNextDurationMs = toNextDurations[index];
      if (
        fromOriginDurationMs === null ||
        fromOriginDurationMs === undefined ||
        toNextDurationMs === null ||
        toNextDurationMs === undefined ||
        !Number.isFinite(fromOriginDurationMs) ||
        !Number.isFinite(toNextDurationMs) ||
        fromOriginDurationMs < 0 ||
        toNextDurationMs < 0 ||
        fromOriginDurationMs > MAX_WALK_DURATION_MS ||
        toNextDurationMs > MAX_WALK_DURATION_MS ||
        fromOriginDurationMs + toNextDurationMs >
          baselineDurationMs + MAX_NEARBY_DELIVERY_DETOUR_MS
      ) {
        return [];
      }

      return [{ point, fromOriginDurationMs, toNextDurationMs }];
    })
    .sort(
      (left, right) =>
        left.fromOriginDurationMs + left.toNextDurationMs -
          right.fromOriginDurationMs - right.toNextDurationMs ||
        left.point.addressKey.localeCompare(right.point.addressKey),
    )[0] ?? null;
}

export function insertNearbyDeliveryIntoPlan(
  plan: StreetDeliveryPlan,
  completedDeliveryCount: number,
  currentStepIndex: number,
  point: MapAddressPoint,
  origin: SimulationLocation,
  fromOriginLeg: SimulationRouteLeg,
  toNextLeg: SimulationRouteLeg,
): StreetDeliveryPlan {
  const nextDelivery = plan.deliveries[completedDeliveryCount];
  if (
    completedDeliveryCount > plan.deliveries.length ||
    point.status !== "unsent" ||
    plan.deliveries.some(({ addressKey }) => addressKey === point.addressKey)
  ) {
    throw new Error("The nearby address is no longer available for this simulation.");
  }

  const nextWalkStepIndex = currentStepIndex;
  const existingWalkStep = plan.steps[nextWalkStepIndex];
  if (
    !existingWalkStep ||
    nextWalkStepIndex < 0 ||
    (existingWalkStep.kind !== "walk" && existingWalkStep.kind !== "walk-return")
  ) {
    throw new Error("The current walking segment is no longer available for nearby planning.");
  }

  const onwardKind = existingWalkStep.kind;
  const candidateLocation = locationOf(point);
  const fromOrigin = makeRouteStep(
    "walk",
    origin,
    candidateLocation,
    fromOriginLeg,
    existingWalkStep.parkingLocation,
    point,
  );
  fromOrigin.path = withExactEndpoints(fromOriginLeg.path, origin, candidateLocation);
  const deliveryStep = makeStationaryStep(
    "deliver",
    candidateLocation,
    DELIVERY_DURATION_MS,
    existingWalkStep.parkingLocation,
    point,
  );
  const toNext = makeRouteStep(
    onwardKind,
    candidateLocation,
    existingWalkStep.to,
    toNextLeg,
    existingWalkStep.parkingLocation,
    onwardKind === "walk" ? nextDelivery : undefined,
  );
  toNext.path = withExactEndpoints(toNextLeg.path, candidateLocation, existingWalkStep.to);
  if (onwardKind === "walk-return") {
    toNext.addressKey = existingWalkStep.addressKey;
    toNext.address = existingWalkStep.address;
  }
  const steps = [
    ...plan.steps.slice(0, nextWalkStepIndex),
    fromOrigin,
    deliveryStep,
    toNext,
    ...plan.steps.slice(nextWalkStepIndex + 1),
  ];

  return {
    ...plan,
    deliveries: [
      ...plan.deliveries.slice(0, completedDeliveryCount),
      point,
      ...plan.deliveries.slice(completedDeliveryCount),
    ],
    walkingPaths: steps
      .filter((step) => step.kind === "walk" || step.kind === "walk-return")
      .map((step) => step.path),
    totalDistanceMeters:
      plan.totalDistanceMeters -
      existingWalkStep.distanceMeters +
      fromOriginLeg.distanceMeters +
      toNextLeg.distanceMeters,
    steps,
  };
}

export function buildDeliverySimulationPlan(
  plan: StreetDeliveryPlan,
  driveToFirst: SimulationRouteLeg,
  walkingLegs: Array<SimulationRouteLeg | null>,
  longDriveLegs: Map<number, SimulationRouteLeg>,
  walkReturnLegs: Map<number, SimulationRouteLeg>,
  driveHome: SimulationRouteLeg,
): StreetDeliveryPlan {
  if (walkingLegs.length !== plan.deliveries.length - 1) {
    throw new Error("Google Maps returned an incomplete walking route for the selected addresses.");
  }

  const steps: SimulationStep[] = [];
  const drivingPaths: SimulationLocation[][] = [driveToFirst.path];
  const walkingPaths: SimulationLocation[][] = [];
  let totalDistanceMeters = driveToFirst.distanceMeters;
  let parking = locationOf(plan.deliveries[0]!);
  let current = parking;
  let hasWalkedSinceParking = false;

  steps.push(
    makeRouteStep(
      "drive",
      plan.start,
      parking,
      driveToFirst,
      parking,
      plan.deliveries[0]!,
    ),
  );
  steps.push(makeStationaryStep("park", parking, PARKING_DURATION_MS, parking));
  steps.push(makeStationaryStep("deliver", parking, DELIVERY_DURATION_MS, parking, plan.deliveries[0]!));

  for (let index = 0; index < walkingLegs.length; index += 1) {
    const nextDelivery = plan.deliveries[index + 1]!;
    const destination = locationOf(nextDelivery);
    const walkingLeg = walkingLegs[index];
    const shouldDrive =
      plan.drivingStopAddressKeys.includes(nextDelivery.addressKey) ||
      (walkingLeg !== null && walkingLeg !== undefined &&
        walkingLeg.durationMs > MAX_WALK_DURATION_MS);

    if (!shouldDrive) {
      if (!walkingLeg) {
        throw new Error("Google Maps did not return a walking route for a selected address.");
      }
      steps.push(
        makeRouteStep(
          "walk",
          current,
          destination,
          walkingLeg,
          parking,
          nextDelivery,
        ),
      );
      steps.push(
        makeStationaryStep(
          "deliver",
          destination,
          DELIVERY_DURATION_MS,
          parking,
          nextDelivery,
        ),
      );
      walkingPaths.push(walkingLeg.path);
      hasWalkedSinceParking = true;
      totalDistanceMeters += walkingLeg.distanceMeters;
      current = destination;
      continue;
    }

    if (hasWalkedSinceParking) {
      const returnLeg = walkReturnLegs.get(index);
      if (!returnLeg) {
        throw new Error("Google Maps did not return a walking route to the marked parking point.");
      }
      const returnStep = makeRouteStep("walk-return", current, parking, returnLeg, parking);
      returnStep.path = withExactEndpoints(returnLeg.path, current, parking);
      steps.push(returnStep);
      walkingPaths.push(returnStep.path);
      totalDistanceMeters += returnLeg.distanceMeters;
    }

    steps.push(makeStationaryStep("board", parking, BOARDING_DURATION_MS, parking));
    const driveLeg = longDriveLegs.get(index);
    if (!driveLeg) {
      throw new Error("Google Maps did not return a driving route for the selected street transition.");
    }
    steps.push(
      makeRouteStep(
        "drive",
        parking,
        destination,
        driveLeg,
        destination,
        nextDelivery,
      ),
    );
    steps.push(makeStationaryStep("park", destination, PARKING_DURATION_MS, destination));
    steps.push(
      makeStationaryStep(
        "deliver",
        destination,
        DELIVERY_DURATION_MS,
        destination,
        nextDelivery,
      ),
    );
    drivingPaths.push(driveLeg.path);
    totalDistanceMeters += driveLeg.distanceMeters;
    parking = destination;
    current = destination;
    hasWalkedSinceParking = false;
  }

  if (hasWalkedSinceParking) {
    const returnLeg = walkReturnLegs.get(plan.deliveries.length - 1);
    if (!returnLeg) {
      throw new Error("Google Maps did not return a walking route to the marked parking point.");
    }
    const returnStep = makeRouteStep("walk-return", current, parking, returnLeg, parking);
    returnStep.path = withExactEndpoints(returnLeg.path, current, parking);
    steps.push(returnStep);
    walkingPaths.push(returnStep.path);
    totalDistanceMeters += returnLeg.distanceMeters;
    steps.push(makeStationaryStep("board", parking, BOARDING_DURATION_MS, parking));
  }

  steps.push(makeRouteStep("drive-return", parking, plan.start, driveHome, parking));
  totalDistanceMeters += driveHome.distanceMeters;
  drivingPaths.push(driveHome.path);

  const deliveredInPlanOrder = steps
    .filter((step) => step.kind === "deliver")
    .map((step) => step.addressKey);
  if (
    deliveredInPlanOrder.length !== plan.deliveries.length ||
    deliveredInPlanOrder.some(
      (addressKey, index) => addressKey !== plan.deliveries[index]!.addressKey,
    ) ||
    new Set(deliveredInPlanOrder).size !== plan.deliveries.length
  ) {
    throw new Error("The simulation route does not include every selected address exactly once.");
  }

  return {
    ...plan,
    drivingPaths,
    walkingPaths,
    returnDrivePath: driveHome.path,
    totalDistanceMeters,
    steps,
  };
}

export function getSimulationDuration(steps: SimulationStep[]): number {
  return steps.reduce((total, step) => total + step.durationMs, 0);
}

export function advanceSimulationTime(
  steps: SimulationStep[],
  elapsedMs: number,
  wallClockDeltaMs: number,
  speed: number,
): number {
  const totalDuration = getSimulationDuration(steps);
  let elapsed = Math.max(0, Math.min(elapsedMs, totalDuration));
  let remainingWallClockMs = Math.max(0, wallClockDeltaMs);

  while (remainingWallClockMs > 0 && elapsed < totalDuration) {
    let stepStart = 0;
    const step = steps.find((candidate) => {
      const stepEnd = stepStart + candidate.durationMs;
      if (elapsed < stepEnd) return true;
      stepStart = stepEnd;
      return false;
    });
    if (!step) return totalDuration;

    const playbackMultiplier = step.kind === "cycle-wait" ? 1 : speed;
    const stepEnd = stepStart + step.durationMs;
    const wallClockToStepEnd = (stepEnd - elapsed) / playbackMultiplier;
    if (remainingWallClockMs < wallClockToStepEnd) {
      return elapsed + remainingWallClockMs * playbackMultiplier;
    }

    remainingWallClockMs -= wallClockToStepEnd;
    elapsed = stepEnd;
  }

  return elapsed;
}

export function getSimulationFrame(steps: SimulationStep[], elapsedMs: number): SimulationFrame {
  const totalDuration = getSimulationDuration(steps);
  const elapsed = Math.max(0, Math.min(elapsedMs, totalDuration));
  const deliveredAddresses: string[] = [];
  let stepStart = 0;
  let carHeadingDegrees = 0;

  for (const step of steps) {
    const stepEnd = stepStart + step.durationMs;
    if (elapsed >= stepEnd) {
      if (step.kind === "deliver" && step.addressKey) deliveredAddresses.push(step.addressKey);
      if (step.kind === "drive" || step.kind === "drive-return") {
        carHeadingDegrees = getPathHeading(step.path, 1);
      }
      stepStart = stepEnd;
      continue;
    }

    const fraction = step.durationMs === 0 ? 1 : (elapsed - stepStart) / step.durationMs;
    const position = interpolatePath(step.path, fraction);
    const carIsMoving = step.kind === "drive" || step.kind === "drive-return";
    return {
      kind: step.kind,
      position,
      carPosition: carIsMoving ? position : step.parkingLocation,
      parkedPosition: step.parkingLocation,
      carHeadingDegrees: carIsMoving ? getPathHeading(step.path, fraction) : carHeadingDegrees,
      addressKey: step.addressKey ?? null,
      address: step.address ?? null,
      delivering: step.kind === "deliver",
      deliveredAddresses,
      progress: totalDuration === 0 ? 1 : elapsed / totalDuration,
    };
  }

  const lastStep = steps.at(-1);
  return {
    kind: "complete",
    position: lastStep?.to ?? { lat: 0, lng: 0 },
    carPosition: lastStep?.to ?? { lat: 0, lng: 0 },
    parkedPosition: lastStep?.parkingLocation ?? { lat: 0, lng: 0 },
    carHeadingDegrees,
    addressKey: null,
    address: null,
    delivering: false,
    deliveredAddresses,
    progress: 1,
  };
}

export function getPathHeading(path: SimulationLocation[], fraction: number): number {
  if (path.length < 2) return 0;

  const progress = Math.max(0, Math.min(fraction, 1));
  const segmentLengths = path.slice(1).map((point, index) => distanceMeters(path[index]!, point));
  const totalLength = segmentLengths.reduce((total, length) => total + length, 0);
  if (totalLength === 0) return 0;

  let remainingDistance = totalLength * progress;
  let lastMovingSegment = -1;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index]!;
    if (segmentLength === 0) continue;
    lastMovingSegment = index;
    if (remainingDistance <= segmentLength) return bearingDegrees(path[index]!, path[index + 1]!);
    remainingDistance -= segmentLength;
  }

  return lastMovingSegment < 0
    ? 0
    : bearingDegrees(path[lastMovingSegment]!, path[lastMovingSegment + 1]!);
}

export function interpolatePath(
  path: SimulationLocation[],
  fraction: number,
): SimulationLocation {
  if (!path.length) throw new Error("Cannot animate a route without path coordinates.");
  if (path.length === 1) return path[0]!;

  const progress = Math.max(0, Math.min(fraction, 1));
  const segmentLengths = path.slice(1).map((point, index) => distanceMeters(path[index]!, point));
  const totalLength = segmentLengths.reduce((total, length) => total + length, 0);
  if (totalLength === 0) return path.at(-1)!;

  let remainingDistance = totalLength * progress;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index]!;
    if (remainingDistance <= segmentLength || index === segmentLengths.length - 1) {
      const segmentProgress = segmentLength === 0 ? 1 : remainingDistance / segmentLength;
      return interpolateLocation(path[index]!, path[index + 1]!, segmentProgress);
    }
    remainingDistance -= segmentLength;
  }

  return path.at(-1)!;
}

export function interpolateLocation(
  from: SimulationLocation,
  to: SimulationLocation,
  fraction: number,
): SimulationLocation {
  const progress = Math.max(0, Math.min(fraction, 1));
  return {
    lat: from.lat + (to.lat - from.lat) * progress,
    lng: from.lng + (to.lng - from.lng) * progress,
  };
}

function selectNearestStreetFirst(
  start: SimulationLocation,
  points: MapAddressPoint[],
  requestedCount: number,
): MapAddressPoint[] {
  const streetGroups = groupDeliveriesByStreet(points);
  const firstGroupIndex = streetGroups.reduce(
    (nearestIndex, group, index) =>
      distanceToNearestPoint(start, group.points) <
      distanceToNearestPoint(start, streetGroups[nearestIndex]!.points)
        ? index
        : nearestIndex,
    0,
  );
  const firstGroup = streetGroups.splice(firstGroupIndex, 1)[0]!;
  const firstStreetRoute = orderStreetPoints(start, firstGroup.points);
  const firstStop = locationOf(firstStreetRoute[0]!);
  const nearbyGroups = new Set(
    streetGroups
      .filter(
        ({ points: groupPoints }) =>
          distanceToNearestPoint(firstStop, groupPoints) <= INITIAL_STOP_NEIGHBORHOOD_RADIUS_METERS,
      )
      .map(({ key }) => key),
  );
  const ordered = [...firstStreetRoute];
  let current = locationOf(firstStreetRoute.at(-1)!);

  while (streetGroups.length && (nearbyGroups.size > 0 || ordered.length < requestedCount)) {
    const candidates = streetGroups
      .filter(({ key }) => nearbyGroups.size === 0 || nearbyGroups.has(key))
      .sort(
        (left, right) =>
          distanceToNearestPoint(current, left.points) -
            distanceToNearestPoint(current, right.points) ||
          left.key.localeCompare(right.key),
      );
    const next = candidates[0]!;
    const streetRoute = orderStreetPoints(current, next.points);
    ordered.push(...streetRoute);
    current = locationOf(streetRoute.at(-1)!);
    nearbyGroups.delete(next.key);
    streetGroups.splice(
      streetGroups.findIndex(({ key }) => key === next.key),
      1,
    );
  }

  return ordered;
}

function getAvailableStreetCandidates(
  candidates: Array<{ group: StreetGroup; entry: MapAddressPoint }>,
  durations: Array<number | null>,
  allowAnyDuration: boolean,
): Array<{ group: StreetGroup; entry: MapAddressPoint; durationMs: number }> {
  return candidates.flatMap((candidate, index) => {
    const durationMs = durations[index];
    if (
      durationMs === null ||
      durationMs === undefined ||
      (!allowAnyDuration && durationMs > MAX_WALK_DURATION_MS)
    ) {
      return [];
    }

    return [{ ...candidate, durationMs }];
  });
}

function validateDurationResults(
  durations: Array<number | null>,
  expectedCount: number,
): void {
  if (
    durations.length !== expectedCount ||
    durations.some(
      (duration) =>
        duration !== null && (!Number.isFinite(duration) || duration < 0),
    )
  ) {
    throw new Error("Google Maps returned incomplete or invalid street route durations.");
  }
}

interface StreetGroup {
  key: string;
  points: MapAddressPoint[];
}

function groupDeliveriesByStreet(deliveries: MapAddressPoint[]): StreetGroup[] {
  const groups = new Map<string, MapAddressPoint[]>();

  for (const point of deliveries) {
    const key = point.street?.trim()
      ? normalizeAddressPart(point.street)
      : `address:${point.addressKey}`;
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  }

  return [...groups].map(([key, points]) => ({ key, points }));
}

function orderStreetPoints(
  start: SimulationLocation,
  points: MapAddressPoint[],
): MapAddressPoint[] {
  const remaining = [...points];
  const ordered: MapAddressPoint[] = [];
  let current = start;

  while (remaining.length) {
    remaining.sort(
      (left, right) =>
        distanceMeters(current, left) - distanceMeters(current, right) ||
        left.address.localeCompare(right.address),
    );
    const next = remaining.shift()!;
    ordered.push(next);
    current = locationOf(next);
  }

  return ordered;
}

function distanceToNearestPoint(
  from: SimulationLocation,
  points: MapAddressPoint[],
): number {
  return Math.min(...points.map((point) => distanceMeters(from, point)));
}

function makeRouteStep(
  kind: SimulationStepKind,
  from: SimulationLocation,
  to: SimulationLocation,
  leg: SimulationRouteLeg,
  parkingLocation: SimulationLocation,
  delivery?: MapAddressPoint,
): SimulationStep {
  if (
    !leg.path.length ||
    leg.durationMs < 0 ||
    !Number.isFinite(leg.durationMs) ||
    leg.distanceMeters < 0 ||
    !Number.isFinite(leg.distanceMeters)
  ) {
    throw new Error("Google Maps did not return a usable road route.");
  }

  return {
    kind,
    from,
    to,
    path: leg.path,
    durationMs: leg.durationMs,
    distanceMeters: leg.distanceMeters,
    parkingLocation,
    ...(delivery ? { addressKey: delivery.addressKey, address: delivery.address } : {}),
  };
}

function makeStationaryStep(
  kind: "park" | "board" | "deliver",
  position: SimulationLocation,
  durationMs: number,
  parkingLocation: SimulationLocation,
  delivery?: MapAddressPoint,
): SimulationStep {
  return {
    kind,
    from: position,
    to: position,
    path: [position],
    durationMs,
    distanceMeters: 0,
    parkingLocation,
    ...(delivery ? { addressKey: delivery.addressKey, address: delivery.address } : {}),
  };
}

function withExactEndpoints(
  path: SimulationLocation[],
  from: SimulationLocation,
  to: SimulationLocation,
): SimulationLocation[] {
  if (path.length < 2) return [from, to];
  return [from, ...path.slice(1, -1), to];
}

function locationOf(point: Pick<SimulationLocation, "lat" | "lng">): SimulationLocation {
  return { lat: point.lat, lng: point.lng };
}

function distanceMeters(
  from: SimulationLocation,
  to: Pick<SimulationLocation, "lat" | "lng">,
): number {
  const earthRadiusMeters = 6_371_000;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = radians(to.lat - from.lat);
  const deltaLng = radians(to.lng - from.lng);
  const fromLat = radians(from.lat);
  const toLat = radians(to.lat);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLng / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function bearingDegrees(from: SimulationLocation, to: SimulationLocation): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const fromLat = radians(from.lat);
  const toLat = radians(to.lat);
  const deltaLng = radians(to.lng - from.lng);
  const y = Math.sin(deltaLng) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLng);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function normalizeAddressPart(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
