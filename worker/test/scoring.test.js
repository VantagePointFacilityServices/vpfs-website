import { describe, it, expect } from "vitest";
import { checkDisqualifiers, calculateGateScore, tierFromScore } from "../worker.js";

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
