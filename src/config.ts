// Everything the agent is allowed to "know" about the shop. If it's not here, it hands off.
export const SHOP = "Cedar Lane Auto Detailing";
export const TZ = "America/Los_Angeles";
export const SLOT_STEP_MIN = 30; // alternatives are offered on a 30-min grid

// luxon weekday: 1 = Mon ... 7 = Sun. null = closed.
export const HOURS: Record<number, [string, string] | null> = {
  1: ["08:00", "18:00"],
  2: ["08:00", "18:00"],
  3: ["08:00", "18:00"],
  4: ["08:00", "18:00"],
  5: ["08:00", "18:00"],
  6: ["09:00", "16:00"],
  7: null,
};

export const SERVICES: Record<string, { name: string; minutes: number; price: number; includes: string }> = {
  exterior_wash: { name: "Exterior Wash", minutes: 60, price: 45, includes: "hand wash, wheels and tires, windows, tire shine" },
  interior_detail: { name: "Interior Detail", minutes: 60, price: 120, includes: "vacuum, seats and carpets shampooed, dash and panels, interior glass" },
  interior_wash: { name: "Interior Detail & Wash", minutes: 90, price: 150, includes: "the Interior Detail plus the Exterior Wash" },
  full_detail: { name: "Full Detail", minutes: 180, price: 260, includes: "interior detail, exterior wash, clay bar, hand wax" },
};

export const LARGE_VEHICLE_SURCHARGE = 30; // full-size trucks, large SUVs, minivans

export const POLICIES = `
Vehicles: we detail cars, SUVs, pickup trucks and minivans. Full-size trucks, large SUVs (3-row) and minivans add $${LARGE_VEHICLE_SURCHARGE}.
We do NOT do RVs, boats, motorcycles, semi trucks or commercial fleets on the phone - those need a custom quote from the owner (hand off).
Ceramic coating, paint correction, and odor/biohazard cleanup are quoted in person only (hand off).
Prep: remove personal items and valuables, empty the trunk and car seats if you want them cleaned, arrive with at least a quarter tank. No need to pre-wash.
Payment: card or cash at pickup. No deposit needed to book.
Cancellations/reschedules: free, just give us a call - earlier is better.
Running late: we hold the slot for 15 minutes. Later than that, we may need to reschedule.
Drop-off: you can wait in the lobby (wifi + coffee) or drop the car off; we text when it's ready.
Location: 2140 Cedar Lane. Parking out front.
`.trim();
