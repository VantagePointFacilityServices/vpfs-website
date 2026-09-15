import { describe, it, expect } from "vitest";
import {
  checkDisqualifiers,
  calculateGateScore,
  tierFromScore,
  monthsUntilContractRenewal,
} from "../worker.js";

describe("checkDisqualifiers", () => {
  it("passes a lead that clears every gate", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 2500,
      frequency: "daily",
      facilityType: "office",
      postcode: "4211",
    });
    expect(result).toEqual({ disqualified: false, reason: null });
  });

  it("flags budget below the floor", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 500,
      frequency: "daily",
      facilityType: "office",
      postcode: "4211",
    });
    expect(result).toEqual({ disqualified: true, reason: "nurture-budget" });
  });

  it("flags frequency under the weekly floor", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 2000,
      frequency: "weekly",
      facilityType: "office",
      postcode: "4211",
    });
    expect(result).toEqual({ disqualified: true, reason: "nurture-frequency" });
  });

  it("flags an unsupported facility type", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 2000,
      frequency: "daily",
      facilityType: "medical",
      postcode: "4211",
    });
    expect(result).toEqual({ disqualified: true, reason: "nurture-capability-gap" });
  });

  it("flags a postcode outside the service area", () => {
    const result = checkDisqualifiers({
      monthlyBudget: 2000,
      frequency: "daily",
      facilityType: "office",
      postcode: "9999",
    });
    expect(result).toEqual({ disqualified: true, reason: "nurture-out-of-area" });
  });
});

describe("calculateGateScore / tierFromScore", () => {
  it("scores a strong office lead into priority", () => {
    const score = calculateGateScore({ monthlyBudget: 3000, frequency: "daily", facilityType: "office" });
    expect(score).toBe(100);
    expect(tierFromScore(score)).toBe("priority");
  });

  it("scores a mid-range construction lead into standard", () => {
    const score = calculateGateScore({
      monthlyBudget: 1000,
      frequency: "few_times_week",
      facilityType: "construction",
    });
    expect(score).toBe(35);
    expect(tierFromScore(score)).toBe("standard");
  });

  it("scores a bare-minimum qualifying lead into standard-flagged", () => {
    const score = calculateGateScore({ monthlyBudget: 800, frequency: "few_times_week", facilityType: "" });
    expect(score).toBe(25);
    expect(tierFromScore(score)).toBe("standard-flagged");
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
