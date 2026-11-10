import assert from "node:assert/strict";
import test from "node:test";
import type { MapAddressPoint } from "../src/lib/map-address-results.ts";
import {
  advanceSimulationTime,
  buildDeliverySimulationPlan,
  buildStreetDeliveryPlan,
  chooseNearbyDeliveryCandidate,
  getNearbyDeliveryCandidates,
  getSimulationPlanningPoints,
  combineSimulationCyclePlans,
  getPathHeading,
  getSimulationDuration,
  getSimulationFrame,
  getWalkReturnRequests,
  getWalkingRouteChunks,
  insertNearbyDeliveryIntoPlan,
  interpolateLocation,
  interpolatePath,
  isNorthShoreGeocodeResult,
  MAX_SIMULATION_DELIVERIES,
  MAX_NEARBY_DELIVERY_CANDIDATES,
  MAX_NEARBY_DELIVERY_DETOUR_MS,
  MAX_SIMULATION_CYCLES,
  NEARBY_DELIVERY_RADIUS_METERS,
  MAX_WALK_DURATION_MS,
  orderStreetsByRouteTime,
  selectSimulationCycleBatches,
  SIMULATION_CYCLE_DELAY_MS,
  type SimulationLocation,
  type SimulationRouteLeg,
} from "../src/lib/delivery-simulation.ts";

function point(
  address: string,
  lat: number,
  lng: number,
  status: MapAddressPoint["status"] = "unsent",
  addressKey = address,
): MapAddressPoint {
  return {
    addressKey,
    address,
    street: "Example Road",
    houseNumber: null,
    status,
    lat,
    lng,
  };
}

function deliveryPoints(): MapAddressPoint[] {
  return [
    point("A", 0.001, 0),
    point("B", 0.002, 0),
    point("C", 0.003, 0),
    point("D", 0.004, 0),
    point("Sent nearby", 0.00001, 0, "sent"),
    point("Junk nearby", 0.00002, 0, "junk"),
  ];
}

function routeLeg(
  from: SimulationLocation,
  to: SimulationLocation,
  durationMs = 8 * 60 * 1_000,
  distanceMeters = 55,
  path = [from, to],
): SimulationRouteLeg {
  return { path, durationMs, distanceMeters };
}

function makeWalkReturnLegs(
  deliveries: MapAddressPoint[],
  walkingLegs: Array<SimulationRouteLeg | null>,
  drivingStopAddressKeys: ReadonlySet<string> = new Set(),
): Map<number, SimulationRouteLeg> {
  return new Map(
    getWalkReturnRequests(deliveries, walkingLegs, drivingStopAddressKeys).map(
      ({ afterDeliveryIndex, origin, destination }) => [
        afterDeliveryIndex,
        routeLeg(origin, destination),
      ],
    ),
  );
}

function makeRoutedPlan(walkingDurationMs = 8 * 60 * 1_000) {
  const start = { lat: 0, lng: 0 };
  const basePlan = buildStreetDeliveryPlan(start, deliveryPoints(), 4);
  const deliveries = basePlan.deliveries;
  const walkingLegs = deliveries.slice(1).map((destination, index) =>
    routeLeg(
      { lat: deliveries[index]!.lat, lng: deliveries[index]!.lng },
      { lat: destination.lat, lng: destination.lng },
      index === 1 ? walkingDurationMs : 8 * 60 * 1_000,
    ),
  );
  const longDriveLegs = new Map<number, SimulationRouteLeg>();
  if (walkingDurationMs > MAX_WALK_DURATION_MS) {
    longDriveLegs.set(
      1,
      routeLeg(
        { lat: deliveries[0]!.lat, lng: deliveries[0]!.lng },
        { lat: deliveries[2]!.lat, lng: deliveries[2]!.lng },
        3 * 60 * 1_000,
        300,
      ),
    );
  }
  const plan = buildDeliverySimulationPlan(
    basePlan,
    routeLeg(start, { lat: deliveries[0]!.lat, lng: deliveries[0]!.lng }, 20_000, 1_200),
    walkingLegs,
    longDriveLegs,
    makeWalkReturnLegs(deliveries, walkingLegs),
    routeLeg(
      longDriveLegs.size
        ? { lat: deliveries[2]!.lat, lng: deliveries[2]!.lng }
        : { lat: deliveries.at(-1)!.lat, lng: deliveries.at(-1)!.lng },
      start,
      18_000,
      1_100,
    ),
  );

  return { plan, walkingLegs };
}

test("accepts known North Shore geocoding components only", () => {
  assert.equal(isNorthShoreGeocodeResult(["5 The Avenue", "Albany", "Auckland"]), true);
  assert.equal(isNorthShoreGeocodeResult(["5 Example Road", "Wellington"]), false);
  assert.equal(isNorthShoreGeocodeResult([]), false);
});

test("finds only the nearest unplanned Unsent addresses within the nearby radius", () => {
  const points = [
    ...Array.from({ length: MAX_NEARBY_DELIVERY_CANDIDATES + 2 }, (_, index) =>
      point(`Nearby ${index}`, index * 0.0001, 0, "unsent", `near-${index}`),
    ),
    point("Already sent", 0.00001, 0, "sent", "sent"),
    point("Too far", NEARBY_DELIVERY_RADIUS_METERS / 100_000, 0, "unsent", "far"),
  ];
  const candidates = getNearbyDeliveryCandidates(
    { lat: 0, lng: 0 },
    points,
    new Set(["near-0"]),
  );

  assert.equal(candidates.length, MAX_NEARBY_DELIVERY_CANDIDATES);
  assert.equal(candidates[0]?.addressKey, "near-1");
  assert.equal(candidates.some(({ addressKey }) => addressKey === "sent"), false);
  assert.equal(candidates.some(({ addressKey }) => addressKey === "far"), false);
});

test("chooses a reachable nearby address only when its detour stays within budget", () => {
  const candidates = [
    point("Good detour", 0.0001, 0, "unsent", "good"),
    point("Long detour", 0.0002, 0, "unsent", "long"),
    point("Long individual leg", 0.0003, 0, "unsent", "leg"),
  ];
  const baseline = 5 * 60_000;
  const selected = chooseNearbyDeliveryCandidate(
    candidates,
    [2 * 60_000, 5 * 60_000, MAX_WALK_DURATION_MS + 1],
    [2 * 60_000, 5 * 60_000, 1_000],
    baseline,
  );

  assert.equal(selected?.point.addressKey, "good");
  assert.equal(selected?.fromOriginDurationMs + selected?.toNextDurationMs, 4 * 60_000);
  assert.equal(
    chooseNearbyDeliveryCandidate(candidates.slice(1, 2), [5 * 60_000], [5 * 60_000], baseline),
    null,
  );
  assert.equal(
    chooseNearbyDeliveryCandidate(
      candidates.slice(0, 1),
      [baseline + MAX_NEARBY_DELIVERY_DETOUR_MS + 1],
      [0],
      baseline,
    ),
    null,
  );
});

test("inserts a nearby delivery into the remaining route without changing completed deliveries", () => {
  const { plan } = makeRoutedPlan();
  const completedDeliveryCount = 1;
  const next = plan.deliveries[completedDeliveryCount]!;
  const existingWalk = plan.steps.find(
    ({ kind, addressKey }) => kind === "walk" && addressKey === next.addressKey,
  )!;
  const candidate = point(
    "Nearby address",
    (existingWalk.from.lat + existingWalk.to.lat) / 2,
    (existingWalk.from.lng + existingWalk.to.lng) / 2,
    "unsent",
    "nearby",
  );
  const updatedPlan = insertNearbyDeliveryIntoPlan(
    plan,
    completedDeliveryCount,
    plan.steps.indexOf(existingWalk),
    candidate,
    existingWalk.from,
    routeLeg(existingWalk.from, candidate, 60_000, 80),
    routeLeg(candidate, existingWalk.to, 60_000, 90),
  );

  assert.deepEqual(
    updatedPlan.deliveries.map(({ addressKey }) => addressKey),
    [
      ...plan.deliveries.slice(0, completedDeliveryCount).map(({ addressKey }) => addressKey),
      "nearby",
      ...plan.deliveries.slice(completedDeliveryCount).map(({ addressKey }) => addressKey),
    ],
  );
  assert.deepEqual(
    updatedPlan.steps.filter(({ kind }) => kind === "deliver").map(({ addressKey }) => addressKey),
    updatedPlan.deliveries.map(({ addressKey }) => addressKey),
  );
  assert.equal(updatedPlan.steps.filter(({ addressKey }) => addressKey === "nearby").length, 2);
  assert.equal(
    updatedPlan.totalDistanceMeters,
    plan.totalDistanceMeters - existingWalk.distanceMeters + 170,
  );
  assert.equal(
    getSimulationFrame(
      updatedPlan.steps,
      getSimulationDuration(updatedPlan.steps),
    ).deliveredAddresses.includes("nearby"),
    true,
  );
});

test("can add one nearby address before walking back to the marked parking point", () => {
  const start = { lat: 0, lng: 0 };
  const basePlan = buildStreetDeliveryPlan(
    start,
    [
      { ...point("A", 0.001, 0), street: "Example Road" },
      { ...point("B", 0.002, 0), street: "Example Road" },
    ],
    2,
  );
  const [first, second] = basePlan.deliveries;
  const walkingLeg = routeLeg(first!, second!);
  const plan = buildDeliverySimulationPlan(
    basePlan,
    routeLeg(start, first!),
    [walkingLeg],
    new Map(),
    makeWalkReturnLegs(basePlan.deliveries, [walkingLeg]),
    routeLeg(first!, start),
  );
  const returnStepIndex = plan.steps.findIndex(({ kind }) => kind === "walk-return");
  const returnStep = plan.steps[returnStepIndex]!;
  const candidate = point("Near parking return", 0.0015, 0.0001, "unsent", "near-return");
  const updatedPlan = insertNearbyDeliveryIntoPlan(
    plan,
    plan.deliveries.length,
    returnStepIndex,
    candidate,
    returnStep.from,
    routeLeg(returnStep.from, candidate, 60_000, 80),
    routeLeg(candidate, returnStep.to, 60_000, 90),
  );

  assert.equal(updatedPlan.deliveries.at(-1)?.addressKey, "near-return");
  assert.equal(updatedPlan.steps.filter(({ kind }) => kind === "walk-return").length, 1);
  assert.deepEqual(
    updatedPlan.steps
      .filter(({ kind }) => kind === "deliver")
      .map(({ addressKey }) => addressKey),
    updatedPlan.deliveries.map(({ addressKey }) => addressKey),
  );
});

test("selects repeated delivery batches without duplicating addresses from earlier runs", () => {
  const points = Array.from({ length: 5 }, (_, index) => ({
      ...point(`Address ${index}`, 0.02 + index * 0.02, 0, "unsent", `address-${index}`),
      street: `Road ${index}`,
    }));
  const batches = selectSimulationCycleBatches(
    { lat: 0, lng: 0 },
    points,
    2,
    3,
  );

  assert.deepEqual(
    batches.map((batch) => batch.map(({ addressKey }) => addressKey)),
    [
      ["address-0", "address-1"],
      ["address-2", "address-3"],
      ["address-4"],
    ],
  );
  assert.deepEqual(
    selectSimulationCycleBatches({ lat: 0, lng: 0 }, points, 2, 2, new Set(["address-0"]))
      .flat()
      .map(({ addressKey }) => addressKey),
    ["address-1", "address-2", "address-3", "address-4"],
  );
  assert.throws(
    () => selectSimulationCycleBatches({ lat: 0, lng: 0 }, points, 2, MAX_SIMULATION_CYCLES + 1),
    /Choose between 1 and/,
  );
});

test("includes Junk mail as an unsent simulation candidate only when its status is unknown", () => {
  const points = [
    point("Unsent", 0.001, 0, "unsent"),
    point("Junk", 0.002, 0, "junk"),
    point("Sent", 0.003, 0, "sent"),
  ];

  assert.deepEqual(
    getSimulationPlanningPoints(points, false).map(({ status }) => status),
    ["unsent", "junk", "sent"],
  );
  assert.deepEqual(
    getSimulationPlanningPoints(points, true).map(({ status }) => status),
    ["unsent", "unsent", "sent"],
  );
  assert.deepEqual(
    selectSimulationCycleBatches(
      { lat: 0, lng: 0 },
      getSimulationPlanningPoints(points, true),
      1,
      1,
    )
      .flat()
      .map(({ addressKey }) => addressKey),
    ["Unsent", "Junk"],
  );
  assert.equal(points[1]?.status, "junk");
});

test("combines routed runs with a ten-second pause at the starting point", () => {
  const first = makeRoutedPlan().plan;
  const secondBase = buildStreetDeliveryPlan(
    first.start,
    [
      point("Run two A", 0.005, 0, "unsent", "run-two-a"),
      point("Run two B", 0.006, 0, "unsent", "run-two-b"),
    ],
    2,
  );
  const [firstSecondRun, secondSecondRun] = secondBase.deliveries;
  const secondWalkingLeg = routeLeg(firstSecondRun!, secondSecondRun!);
  const second = buildDeliverySimulationPlan(
    secondBase,
    routeLeg(secondBase.start, firstSecondRun!),
    [secondWalkingLeg],
    new Map(),
    makeWalkReturnLegs(secondBase.deliveries, [secondWalkingLeg]),
    routeLeg(firstSecondRun!, secondBase.start),
  );
  const combined = combineSimulationCyclePlans([first, second]);
  const waitIndex = combined.steps.findIndex(({ kind }) => kind === "cycle-wait");
  const waitStep = combined.steps[waitIndex]!;
  const waitStart = combined.steps
    .slice(0, waitIndex)
    .reduce((elapsed, step) => elapsed + step.durationMs, 0);

  assert.deepEqual(
    combined.deliveries.map(({ addressKey }) => addressKey),
    [
      ...first.deliveries.map(({ addressKey }) => addressKey),
      ...second.deliveries.map(({ addressKey }) => addressKey),
    ],
  );
  assert.equal(waitStep.durationMs, SIMULATION_CYCLE_DELAY_MS);
  assert.deepEqual(waitStep.from, first.start);
  assert.deepEqual(waitStep.to, first.start);
  assert.equal(waitStep.distanceMeters, 0);
  assert.equal(combined.steps[waitIndex - 1]?.kind, "drive-return");
  assert.equal(combined.steps[waitIndex + 1]?.kind, "drive");
  assert.equal(combined.totalDistanceMeters, first.totalDistanceMeters + second.totalDistanceMeters);
  assert.equal(getSimulationFrame(combined.steps, waitStart + 1).kind, "cycle-wait");
  assert.deepEqual(getSimulationFrame(combined.steps, waitStart + waitStep.durationMs).position, first.start);
  assert.equal(
    advanceSimulationTime(combined.steps, waitStart - 100, 4_000, 50),
    waitStart + 3_998,
  );
  assert.equal(
    advanceSimulationTime(combined.steps, waitStart + 5_000, 5_000, 50),
    waitStart + waitStep.durationMs,
  );
  assert.equal(
    advanceSimulationTime(
      combined.steps,
      waitStart + waitStep.durationMs,
      100,
      50,
    ),
    waitStart + waitStep.durationMs + 5_000,
  );
});

test("selects complete nearest street groups until the target is reached", () => {
  const points = [
    point("A", 0.001, 0),
    point("B", -0.002, 0),
    point("C", 0.003, 0),
    point("D", 0.01, 0),
    point("Sent", 0.00001, 0, "sent"),
    point("Junk", 0.00002, 0, "junk"),
  ];
  const plan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, points, 3);

  assert.deepEqual(plan.deliveries.map(({ address }) => address), ["A", "C", "B", "D"]);
  assert.equal(plan.deliveries.every(({ status }) => status === "unsent"), true);
  assert.equal(plan.steps.length, 0);
});

test("finishes the selected addresses on the current street before changing streets", () => {
  const points = [
    { ...point("Landing Dr 1", 0.001, 0), street: "Landing Dr" },
    { ...point("Landing Dr 2", 0.01, 0), street: "Landing Dr" },
    { ...point("Wharf Rd 1", 0.0001, 0), street: "Wharf Rd" },
    { ...point("Wharf Rd 2", 0.0002, 0), street: "Wharf Rd" },
  ];
  const plan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, points, 4);

  assert.deepEqual(
    plan.deliveries.map(({ address }) => address),
    ["Wharf Rd 1", "Wharf Rd 2", "Landing Dr 1", "Landing Dr 2"],
  );
});

test("includes streets near the initial stop before filling the requested target", () => {
  const points = [
    { ...point("First street 1", 0.001, 0, "unsent", "first-1"), street: "First Street" },
    { ...point("First street 2", 0.0011, 0, "unsent", "first-2"), street: "First Street" },
    { ...point("3 Kanuka Way", 0.002, 0, "unsent", "kanuka-3"), street: "Kanuka Way" },
    { ...point("6 Rimu Rise", 0.0021, 0, "unsent", "rimu-6"), street: "Rimu Rise" },
    { ...point("Distant Road", 0.02, 0, "unsent", "distant"), street: "Distant Road" },
  ];

  const plan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, points, 2);

  assert.deepEqual(
    plan.deliveries.map(({ addressKey }) => addressKey),
    ["first-1", "first-2", "kanuka-3", "rimu-6"],
  );
});

test("completes nearby first-stop streets even when the target is already reached", () => {
  const points = [
    { ...point("Landing Dr 1", 0.001, 0), street: "Landing Dr" },
    { ...point("Landing Dr 99", 0.02, 0), street: "Landing Dr" },
    { ...point("Wharf Rd 1", 0.0011, 0), street: "Wharf Rd" },
    { ...point("Wharf Rd 2", 0.0012, 0), street: "Wharf Rd" },
  ];
  const plan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, points, 2);

  assert.deepEqual(
    plan.deliveries.map(({ address }) => address),
    ["Landing Dr 1", "Landing Dr 99", "Wharf Rd 2", "Wharf Rd 1"],
  );
});

test("finishes the street that crosses the requested target instead of cutting it short", () => {
  const points = [
    { ...point("Landing Dr 1", 0.001, 0), street: "Landing Dr" },
    { ...point("Landing Dr 2", 0.002, 0), street: "Landing Dr" },
    { ...point("Landing Dr 3", 0.003, 0), street: "Landing Dr" },
    { ...point("Landing Dr 4", 0.004, 0), street: "Landing Dr" },
    { ...point("Wharf Rd 1", 0.02, 0), street: "Wharf Rd" },
  ];
  const plan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, points, 3);

  assert.deepEqual(
    plan.deliveries.map(({ address }) => address),
    ["Landing Dr 1", "Landing Dr 2", "Landing Dr 3", "Landing Dr 4"],
  );
});

test("excludes addresses already delivered by earlier simulation batches", () => {
  const points = [
    { ...point("Landing Dr 1", 0.001, 0), street: "Landing Dr" },
    { ...point("Landing Dr 2", 0.002, 0), street: "Landing Dr" },
    { ...point("Wharf Rd 1", 0.003, 0), street: "Wharf Rd" },
  ];
  const plan = buildStreetDeliveryPlan(
    { lat: 0, lng: 0 },
    points,
    1,
    new Set(["Landing Dr 1", "Landing Dr 2"]),
  );

  assert.deepEqual(plan.deliveries.map(({ address }) => address), ["Wharf Rd 1"]);
  assert.equal(plan.deliveries.some(({ addressKey }) => addressKey === "Landing Dr 1"), false);
});

test("keeps the selected nearest first street and orders later streets by route time", async () => {
  const points = [
    { ...point("A", 0, 0.001, "unsent", "a"), street: "A Street" },
    { ...point("B", 0.001, 0, "unsent", "b"), street: "B Street" },
    { ...point("C", 0.002, 0, "unsent", "c"), street: "C Street" },
  ];
  const calls: string[] = [];
  const ordered = await orderStreetsByRouteTime(
    { lat: 0, lng: 0 },
    points,
    async (_origin, destinations, mode) => {
      calls.push(`${mode}:${destinations.length}`);
      if (mode === "DRIVING" && destinations.length === 3) return [60_000, 30_000, 90_000];
      if (mode === "WALKING" && destinations.length === 2) {
        return [MAX_WALK_DURATION_MS + 1, 4 * 60_000];
      }
      if (mode === "WALKING") return [MAX_WALK_DURATION_MS + 1];
      return [2 * 60_000];
    },
  );

  assert.deepEqual(
    ordered.deliveries.map(({ addressKey }) => addressKey),
    ["a", "c", "b"],
  );
  assert.deepEqual(ordered.drivingStopAddressKeys, ["b"]);
  assert.deepEqual(calls, ["DRIVING:1", "WALKING:2", "WALKING:1", "DRIVING:1"]);
});

test("uses stable address keys when multiple delivery records share the same label", () => {
  const sameLabelPoints = [
    point("Unit 1, Example Road", 0.001, 0, "unsent", "property-1"),
    point("Unit 1, Example Road", 0.002, 0, "unsent", "property-2"),
  ];
  const basePlan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, sameLabelPoints, 2);
  const [first, second] = basePlan.deliveries;
  const plan = buildDeliverySimulationPlan(
    basePlan,
    routeLeg(basePlan.start, first!),
    [routeLeg(first!, second!)],
    new Map(),
    makeWalkReturnLegs(basePlan.deliveries, [routeLeg(first!, second!)]),
    routeLeg(second!, basePlan.start),
  );
  const completed = getSimulationFrame(plan.steps, getSimulationDuration(plan.steps));

  assert.deepEqual(completed.deliveredAddresses, ["property-1", "property-2"]);
});

test("validates the requested count and availability of mapped Unsent addresses", () => {
  assert.throws(
    () => buildStreetDeliveryPlan({ lat: 0, lng: 0 }, deliveryPoints(), 0),
    /Choose between 1 and 50/,
  );
  assert.throws(
    () =>
      buildStreetDeliveryPlan(
        { lat: 0, lng: 0 },
        deliveryPoints(),
        MAX_SIMULATION_DELIVERIES + 1,
      ),
    /Choose between 1 and 50/,
  );
  assert.throws(
    () => buildStreetDeliveryPlan({ lat: 0, lng: 0 }, deliveryPoints(), 5),
    /Only 4 mapped Unsent addresses are available; 5 were requested/,
  );
});

test("chunks walking routes within the Google Routes waypoint limit", () => {
  const deliveries = Array.from({ length: 50 }, (_, index) =>
    point(String(index), 0, index * 0.001),
  );
  const chunks = getWalkingRouteChunks(deliveries);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.origin.address, "0");
  assert.equal(chunks[0]?.destination.address, "26");
  assert.equal(chunks[0]?.intermediates.length, 25);
  assert.equal(chunks[1]?.origin.address, "26");
  assert.equal(chunks[1]?.destination.address, "49");
  assert.equal(chunks[1]?.intermediates.length, 22);
  assert.deepEqual(getWalkingRouteChunks([deliveries[0]!]), []);
});

test("splits walking route requests at street transitions assigned to driving", () => {
  const deliveries = Array.from({ length: 5 }, (_, index) =>
    point(String(index), 0, index * 0.001, "unsent", String(index)),
  );
  const chunks = getWalkingRouteChunks(deliveries, new Set(["2"]));

  assert.deepEqual(
    chunks.map(({ startIndex, origin, destination }) => ({
      startIndex,
      origin: origin.addressKey,
      destination: destination.addressKey,
    })),
    [
      { startIndex: 0, origin: "0", destination: "1" },
      { startIndex: 2, origin: "2", destination: "4" },
    ],
  );
});

test("builds road-based walking routes and returns to the start when all legs are walkable", () => {
  const { plan } = makeRoutedPlan();

  assert.deepEqual(plan.deliveries.map(({ address }) => address), ["A", "B", "C", "D"]);
  assert.equal(plan.steps[0]?.kind, "drive");
  assert.equal(plan.steps.at(-3)?.kind, "walk-return");
  assert.equal(plan.steps.at(-2)?.kind, "board");
  assert.equal(plan.steps.at(-1)?.kind, "drive-return");
  assert.deepEqual(plan.steps.at(-1)?.to, plan.start);
  assert.equal(plan.drivingPaths.length, 2);
  assert.equal(plan.walkingPaths.length, 4);
  assert.equal(plan.totalDistanceMeters, 1_200 + 3 * 55 + 55 + 1_100);
  assert.deepEqual(
    plan.steps.filter(({ kind }) => kind === "deliver").map(({ address }) => address),
    plan.deliveries.map(({ address }) => address),
  );
});

test("uses a separately routed path that ends exactly at the parking marker", () => {
  const start = { lat: 0, lng: 0 };
  const basePlan = buildStreetDeliveryPlan(
    start,
    [
      { ...point("A", 0.001, 0), street: "Example Road" },
      { ...point("B", 0.002, 0), street: "Example Road" },
      { ...point("C", 0.003, 0), street: "Example Road" },
    ],
    3,
  );
  const [first, second, last] = basePlan.deliveries;
  const parking = { lat: first!.lat, lng: first!.lng };
  const returnPath = [
    { lat: last!.lat, lng: last!.lng },
    { lat: 0.0015, lng: 0.0005 },
    parking,
  ];
  const walkingLegs = [
    routeLeg(first!, second!),
    routeLeg(second!, last!),
  ];
  assert.deepEqual(
    getWalkReturnRequests(basePlan.deliveries, walkingLegs),
    [{ afterDeliveryIndex: 2, origin: { lat: last!.lat, lng: last!.lng }, destination: parking }],
  );
  const plan = buildDeliverySimulationPlan(
    basePlan,
    routeLeg(start, first!),
    walkingLegs,
    new Map(),
    new Map([[2, routeLeg(last!, parking, 3 * 60_000, 180, returnPath)]]),
    routeLeg(parking, start),
  );
  const returnStep = plan.steps.find(({ kind }) => kind === "walk-return")!;
  const returnStart = plan.steps
    .slice(0, plan.steps.indexOf(returnStep))
    .reduce((elapsed, step) => elapsed + step.durationMs, 0);

  assert.deepEqual(returnStep.path, returnPath);
  assert.deepEqual(returnStep.path.at(-1), parking);
  assert.equal(returnStep.path.some(({ lat, lng }) => lat === second!.lat && lng === second!.lng), false);
  const atParking = getSimulationFrame(
    plan.steps,
    returnStart + returnStep.durationMs,
  );
  assert.deepEqual(atParking.position, parking);
  assert.deepEqual(atParking.carPosition, parking);
});

test("keeps a planned driving street transition instead of walking to its next street", () => {
  const start = { lat: 0, lng: 0 };
  const points = [
    { ...point("A", 0.001, 0, "unsent", "a"), street: "A Street" },
    { ...point("B", 0.002, 0, "unsent", "b"), street: "A Street" },
    { ...point("C", 0.003, 0, "unsent", "c"), street: "B Street" },
  ];
  const basePlan = buildStreetDeliveryPlan(start, points, 3);
  const [first, second, third] = basePlan.deliveries;
  const plan = buildDeliverySimulationPlan(
    { ...basePlan, drivingStopAddressKeys: [third!.addressKey] },
    routeLeg(start, first!),
    [routeLeg(first!, second!, 60_000), null],
    new Map([[1, routeLeg(first!, third!, 120_000)]]),
    makeWalkReturnLegs(
      basePlan.deliveries,
      [routeLeg(first!, second!, 60_000), null],
      new Set([third!.addressKey]),
    ),
    routeLeg(third!, start),
  );
  const kinds = plan.steps.map(({ kind }) => kind);
  const transitionDrive = kinds.indexOf("drive", 1);
  const walkReturn = kinds.indexOf("walk-return");

  assert.equal(kinds[walkReturn + 1], "board");
  assert.equal(kinds[walkReturn + 2], "drive");
  assert.equal(plan.steps[transitionDrive]?.addressKey, "c");
  assert.deepEqual(plan.steps[transitionDrive]?.from, { lat: first!.lat, lng: first!.lng });
  assert.deepEqual(plan.steps[transitionDrive]?.to, { lat: third!.lat, lng: third!.lng });
  const boardingStep = plan.steps[walkReturn + 1]!;
  const boardingStart = plan.steps
    .slice(0, walkReturn + 1)
    .reduce((elapsed, step) => elapsed + step.durationMs, 0);
  const duringBoarding = getSimulationFrame(
    plan.steps,
    boardingStart + boardingStep.durationMs / 2,
  );
  assert.equal(duringBoarding.kind, "board");
  assert.deepEqual(duringBoarding.position, boardingStep.to);
  assert.deepEqual(duringBoarding.carPosition, boardingStep.to);
  assert.deepEqual(duringBoarding.parkedPosition, boardingStep.to);
  assert.deepEqual(plan.steps[transitionDrive]?.from, boardingStep.to);
  assert.equal(plan.steps.some(({ kind, addressKey }) => kind === "walk" && addressKey === "c"), false);
});

test("switches to driving for legs over ten minutes after returning to the parking point", () => {
  const { plan } = makeRoutedPlan(MAX_WALK_DURATION_MS + 1);
  const kinds = plan.steps.map(({ kind }) => kind);
  const returnToParking = kinds.indexOf("walk-return");
  const driveToNext = kinds.indexOf("drive", returnToParking);

  assert.equal(kinds[returnToParking + 1], "board");
  assert.equal(kinds[returnToParking + 2], "drive");
  assert.equal(kinds[driveToNext + 1], "park");
  assert.equal(plan.steps[driveToNext]?.address, "C");
  assert.deepEqual(plan.steps[driveToNext]?.from, { lat: 0.001, lng: 0 });
  assert.deepEqual(plan.steps[driveToNext]?.to, { lat: 0.003, lng: 0 });
  assert.deepEqual(plan.steps.at(-1)?.from, { lat: 0.003, lng: 0 });
  assert.equal(plan.totalDistanceMeters, 1_200 + 2 * 55 + 300 + 2 * 55 + 1_100);
});

test("keeps a walking leg of exactly ten minutes on foot", () => {
  const { plan } = makeRoutedPlan(MAX_WALK_DURATION_MS);

  assert.equal(plan.steps.some(({ kind }) => kind === "drive"), true);
  assert.equal(plan.steps.filter(({ kind }) => kind === "drive").length, 1);
  assert.equal(plan.steps.some(({ kind }) => kind === "walk-return"), true);
});

test("rejects incomplete walking routes and missing driving routes", () => {
  const basePlan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, deliveryPoints(), 4);
  assert.throws(
    () =>
      buildDeliverySimulationPlan(
        basePlan,
        routeLeg(basePlan.start, basePlan.start),
        [],
        new Map(),
        makeWalkReturnLegs(basePlan.deliveries, []),
        routeLeg(basePlan.start, basePlan.start),
      ),
    /incomplete walking route/,
  );

  const { plan: walkablePlan, walkingLegs } = makeRoutedPlan(MAX_WALK_DURATION_MS + 1);
  const unsolvedPlan = buildStreetDeliveryPlan({ lat: 0, lng: 0 }, deliveryPoints(), 4);
  assert.throws(
    () =>
      buildDeliverySimulationPlan(
        unsolvedPlan,
        routeLeg(unsolvedPlan.start, unsolvedPlan.start),
        walkingLegs,
        new Map(),
        makeWalkReturnLegs(walkablePlan.deliveries, walkingLegs),
        routeLeg(unsolvedPlan.start, unsolvedPlan.start),
      ),
    /did not return a driving route/,
  );
  assert.equal(walkablePlan.deliveries.length, 4);

  assert.throws(
    () =>
      buildDeliverySimulationPlan(
        basePlan,
        routeLeg(basePlan.start, basePlan.start, 1, 1, []),
        Array.from({ length: 3 }, () => routeLeg(basePlan.start, basePlan.start)),
        new Map(),
        new Map(),
        routeLeg(basePlan.start, basePlan.start),
      ),
    /usable road route/,
  );
});

test("animates along route geometry, exposes simulation-only deliveries, and finishes at the start", () => {
  const { plan } = makeRoutedPlan();
  const firstStep = plan.steps[0]!;
  const afterDrive = getSimulationFrame(plan.steps, firstStep.durationMs);
  const drivingReturn = plan.steps.at(-1)!;
  const returnStart = getSimulationDuration(plan.steps) - drivingReturn.durationMs;
  const duringDriveHome = getSimulationFrame(
    plan.steps,
    returnStart + drivingReturn.durationMs / 2,
  );
  const completed = getSimulationFrame(plan.steps, getSimulationDuration(plan.steps) + 1);

  assert.deepEqual(afterDrive.position, {
    lat: plan.deliveries[0]!.lat,
    lng: plan.deliveries[0]!.lng,
  });
  assert.equal(duringDriveHome.kind, "drive-return");
  assert.notDeepEqual(duringDriveHome.position, plan.start);
  assert.deepEqual(completed.position, plan.start);
  assert.deepEqual(completed.carPosition, plan.start);
  assert.equal(completed.deliveredAddresses.length, 4);
  assert.equal(completed.progress, 1);
  assert.equal(getSimulationFrame(plan.steps, firstStep.durationMs + 1).carPosition.lat, 0.001);
  assert.deepEqual(getSimulationFrame([], 0).position, { lat: 0, lng: 0 });
});

test("derives the car heading from its road route while walking proceeds independently", () => {
  const start = { lat: 0, lng: 0 };
  const basePlan = buildStreetDeliveryPlan(
    start,
    [
      { ...point("A", 0, 0.001), street: "Example Road" },
      { ...point("B", 0.001, 0.001), street: "Example Road" },
    ],
    2,
  );
  const [first, second] = basePlan.deliveries;
  const plan = buildDeliverySimulationPlan(
    basePlan,
    routeLeg(start, first!),
    [routeLeg(first!, second!)],
    new Map(),
    makeWalkReturnLegs(basePlan.deliveries, [routeLeg(first!, second!)]),
    routeLeg(second!, start),
  );
  const driveStep = plan.steps.find(({ kind }) => kind === "drive")!;
  const driveStepStart =
    plan.steps
      .slice(0, plan.steps.indexOf(driveStep))
      .reduce((elapsed, step) => elapsed + step.durationMs, 0);
  const duringDrive = getSimulationFrame(
    plan.steps,
    driveStepStart + driveStep.durationMs / 2,
  );
  const walkStep = plan.steps.find(({ kind }) => kind === "walk")!;
  const walkStepStart =
    plan.steps
      .slice(0, plan.steps.indexOf(walkStep))
      .reduce((elapsed, step) => elapsed + step.durationMs, 0);
  const duringWalk = getSimulationFrame(plan.steps, walkStepStart + walkStep.durationMs / 2);

  assert.equal(getPathHeading([{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }], 0.5), 0);
  assert.equal(getPathHeading([{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }], 0.5), 90);
  assert.equal(duringDrive.carHeadingDegrees, 90);
  assert.equal(duringWalk.carHeadingDegrees, duringDrive.carHeadingDegrees);
  assert.equal(getSimulationFrame([], 0).carHeadingDegrees, 0);
});

test("interpolates positions by traveled route distance and clamps fractions", () => {
  assert.deepEqual(
    interpolatePath(
      [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 1 },
        { lat: 1, lng: 1 },
      ],
      0.5,
    ),
    { lat: 0, lng: 1 },
  );
  assert.deepEqual(interpolatePath([{ lat: 0, lng: 0 }], 0.5), { lat: 0, lng: 0 });
  assert.throws(() => interpolatePath([], 0.5), /without path coordinates/);
  assert.deepEqual(
    interpolatePath([{ lat: 1, lng: 1 }, { lat: 1, lng: 1 }], 0.5),
    { lat: 1, lng: 1 },
  );
  assert.deepEqual(
    interpolateLocation({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 0.5),
    { lat: 5, lng: 10 },
  );
  assert.deepEqual(
    interpolateLocation({ lat: 0, lng: 0 }, { lat: 10, lng: 20 }, 2),
    { lat: 10, lng: 20 },
  );
});
