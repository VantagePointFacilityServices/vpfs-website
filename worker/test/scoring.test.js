import { describe, it, expect } from "vitest";
import {
  checkDisqualifiers,
  leadFlags,
  calculateGateScore,
  tierFromScore,
  monthsUntilContractRenewal,
} from "../worker.js";

describe("checkDisqualifiers", () => {
  it("passes a lead at the $2,000 minimum", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 2000,
      frequency: "three_days_week",
      facilityType: "office",
      postcode: "4211",
    });
    expect(result).toEqual({ disqualified: false, reason: null });
  });

  it("flags a budget under $2,000/month — the only disqualifier", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 1999,
      frequency: "daily",
      facilityType: "office",
      postcode: "4211",
    });
    expect(result).toEqual({ disqualified: true, reason: "nurture-budget" });
  });

  it.each([
    ["weekly cleaning", { frequency: "weekly" }],
    ["fortnightly cleaning", { frequency: "fortnightly" }],
    ["a medical facility", { facilityType: "medical" }],
    ["an education facility", { facilityType: "education" }],
    ["a postcode outside the core service area", { postcode: "4217" }],
  ])("does not disqualify %s — budget alone decides", (_, override) => {
    const result = checkDisqualifiers({
      monthlyBudget: 3000,
      frequency: "daily",
      facilityType: "office",
      postcode: "4211",
      ...override,
    });
    expect(result).toEqual({ disqualified: false, reason: null });
  });
});

describe("leadFlags", () => {
  const clean = { monthlyBudget: 3000, frequency: "daily", facilityType: "office", postcode: "4211" };

  it("returns no flags for a lead that fits every service rule", () => {
    expect(leadFlags(clean)).toEqual([]);
  });

  it.each([
    [{ frequency: "weekly" }, ["low-frequency"]],
    [{ frequency: "fortnightly" }, ["low-frequency"]],
    [{ facilityType: "medical" }, ["capability-gap"]],
    [{ postcode: "4217" }, ["out-of-area"]],
    [{ frequency: "weekly", facilityType: "education", postcode: "9999" }, ["low-frequency", "capability-gap", "out-of-area"]],
  ])("flags %j as %j for the team to review", (override, expected) => {
    expect(leadFlags({ ...clean, ...override })).toEqual(expected);
  });

  it("never flags blank answers", () => {
    expect(leadFlags({ monthlyBudget: 0, frequency: "", facilityType: "", postcode: "" })).toEqual([]);
  });
});

describe("calculateGateScore / tierFromScore", () => {
  it("scores the strongest lead at 100 — priority", () => {
    const score = calculateGateScore({ monthlyBudget: 6000, frequency: "daily", facilityType: "office" });
    expect(score).toBe(100);
    expect(tierFromScore(score)).toBe("priority");
  });

  it("puts any $5,000+ budget in priority, even at the weakest frequency and facility fit", () => {
    const score = calculateGateScore({
      monthlyBudget: 5000,
      frequency: "three_days_week",
      facilityType: "construction",
    });
    expect(score).toBe(85);
    expect(tierFromScore(score)).toBe("priority");
  });

  it("keeps a $2,000–$4,999 budget in standard, even at the strongest frequency and facility fit", () => {
    const score = calculateGateScore({ monthlyBudget: 4999, frequency: "daily", facilityType: "strata" });
    expect(score).toBe(60);
    expect(tierFromScore(score)).toBe("standard");
  });

  it("scores the bare-minimum qualifying lead into standard", () => {
    const score = calculateGateScore({
      monthlyBudget: 2000,
      frequency: "three_days_week",
      facilityType: "construction",
    });
    expect(score).toBe(45);
    expect(tierFromScore(score)).toBe("standard");
  });

  it("ranks 5 days a week between daily and 3 days a week", () => {
    const base = { monthlyBudget: 2000, facilityType: "office" };
    const daily = calculateGateScore({ ...base, frequency: "daily" });
    const five = calculateGateScore({ ...base, frequency: "five_days_week" });
    const three = calculateGateScore({ ...base, frequency: "three_days_week" });
    expect([daily, five, three]).toEqual([60, 55, 50]);
  });

  it("still scores the legacy few_times_week value as 3 days a week", () => {
    const base = { monthlyBudget: 2000, facilityType: "office" };
    expect(calculateGateScore({ ...base, frequency: "few_times_week" })).toBe(
      calculateGateScore({ ...base, frequency: "three_days_week" })
    );
  });

  it("never puts a lead with no budget given (e.g. from the AI Receptionist) in priority", () => {
    const score = calculateGateScore({ monthlyBudget: 0, frequency: "daily", facilityType: "office" });
    expect(score).toBe(30);
    expect(tierFromScore(score)).toBe("standard");
    expect(tierFromScore(calculateGateScore({ monthlyBudget: 0, frequency: "", facilityType: "" }))).toBe(
      "standard-flagged"
    );
  });
});

describe("monthsUntilContractRenewal", () => {
  const now = new Date("2026-09-15T00:00:00Z");

  it("returns null for a missing date", () => {
    expect(monthsUntilContractRenewal("", now)).toBeNull();
    expect(monthsUntilContractRenewal(undefined, now)).toBeNull();
  });

  it("returns null for an unparseable date", () => {
    expect(monthsUntilContractRenewal("not-a-date", now)).toBeNull();
  });

  it("returns a small positive number for a renewal a couple months out", () => {
    const months = monthsUntilContractRenewal("2026-11-15", now);
    expect(months).toBeGreaterThan(1.8);
    expect(months).toBeLessThan(2.2);
  });

  it("returns a large positive number for a renewal over a year out", () => {
    const months = monthsUntilContractRenewal("2028-09-15", now);
    expect(months).toBeGreaterThan(23);
  });

  it("returns a negative number for a renewal date already in the past", () => {
    const months = monthsUntilContractRenewal("2026-01-15", now);
    expect(months).toBeLessThan(0);
  });

  it("defaults `now` to the real clock when not provided", () => {
    // Any date far in the future stays far in the future regardless of when the suite runs.
    const months = monthsUntilContractRenewal("2099-01-01");
    expect(months).toBeGreaterThan(0);
  });
});
