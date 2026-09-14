import { describe, it, expect } from "vitest";
import {
  checkApplicantAreaDisqualifier,
  checkApplicantDisqualifiers,
  calculateApplicantScore,
  applicantTierFromScore,
} from "../worker.js";

describe("checkApplicantAreaDisqualifier (Stage 1)", () => {
  it("passes an applicant inside the service area", () => {
    const result = checkApplicantAreaDisqualifier({ postcode: "4211" });
    expect(result).toEqual({ disqualified: false, reason: null });
  });

  it("flags a postcode outside the service area", () => {
    const result = checkApplicantAreaDisqualifier({ postcode: "9999" });
    expect(result).toEqual({ disqualified: true, reason: "unsuccessful-out-of-area" });
  });

  it("does not disqualify on a missing (not explicitly out-of-area) postcode", () => {
    const result = checkApplicantAreaDisqualifier({ postcode: "" });
    expect(result).toEqual({ disqualified: false, reason: null });
  });
});

describe("checkApplicantDisqualifiers (Stage 2)", () => {
  const baseline = {
    experience: "1_to_3_years",
    rightToWork: "yes",
    policeCheckStatus: "willing_no_current_check",
  };

  it("passes an applicant who clears every gate", () => {
    const result = checkApplicantDisqualifiers(baseline);
    expect(result).toEqual({ disqualified: false, reason: null });
  });

  it("flags zero experience", () => {
    const result = checkApplicantDisqualifiers({ ...baseline, experience: "none" });
    expect(result).toEqual({ disqualified: true, reason: "unsuccessful-insufficient-experience" });
  });

  it("flags under a year of experience", () => {
    const result = checkApplicantDisqualifiers({ ...baseline, experience: "under_1_year" });
    expect(result).toEqual({ disqualified: true, reason: "unsuccessful-insufficient-experience" });
  });

  it("does not disqualify on 1-3 years or 3+ years experience", () => {
    expect(checkApplicantDisqualifiers({ ...baseline, experience: "1_to_3_years" }).disqualified).toBe(
      false
    );
    expect(checkApplicantDisqualifiers({ ...baseline, experience: "3_plus_years" }).disqualified).toBe(
      false
    );
  });

  it("flags no right to work", () => {
    const result = checkApplicantDisqualifiers({ ...baseline, rightToWork: "no" });
    expect(result).toEqual({ disqualified: true, reason: "unsuccessful-no-right-to-work" });
  });

  it("flags an applicant unwilling to complete a police check", () => {
    const result = checkApplicantDisqualifiers({ ...baseline, policeCheckStatus: "not_willing" });
    expect(result).toEqual({ disqualified: true, reason: "unsuccessful-no-police-check" });
  });

  it("does not disqualify on already holding a current police check", () => {
    const result = checkApplicantDisqualifiers({
      ...baseline,
      policeCheckStatus: "current_check_held",
    });
    expect(result).toEqual({ disqualified: false, reason: null });
  });

  it("experience is checked before right to work and the police check", () => {
    const result = checkApplicantDisqualifiers({
      experience: "none",
      rightToWork: "no",
      policeCheckStatus: "not_willing",
    });
    expect(result.reason).toBe("unsuccessful-insufficient-experience");
  });

  it("right-to-work is checked before the police check", () => {
    const result = checkApplicantDisqualifiers({
      ...baseline,
      rightToWork: "no",
      policeCheckStatus: "not_willing",
    });
    expect(result.reason).toBe("unsuccessful-no-right-to-work");
  });

  it("never disqualifies on Blue Card or insurance/ABN status — enrichment signals only", () => {
    const result = checkApplicantDisqualifiers({
      ...baseline,
      blueCardStatus: "not_applicable",
      hasOwnInsuranceAndAbn: "no",
    });
    expect(result).toEqual({ disqualified: false, reason: null });
  });
});

describe("calculateApplicantScore / applicantTierFromScore", () => {
  it("scores a strong, experienced, flexible applicant into priority", () => {
    const score = calculateApplicantScore({
      experience: "3_plus_years",
      availability: "flexible",
      passion: "genuinely_passionate",
      reliableTransport: "yes",
      physicalCapability: "yes",
    });
    expect(score).toBe(100);
    expect(applicantTierFromScore(score)).toBe("priority");
  });

  it("scores a mid-range applicant into standard", () => {
    const score = calculateApplicantScore({
      experience: "1_to_3_years",
      availability: "business_hours",
      passion: "take_pride",
      reliableTransport: "yes",
      physicalCapability: "no",
    });
    expect(score).toBe(55);
    expect(applicantTierFromScore(score)).toBe("standard");
  });

  it("scores an under-floor applicant at zero on the experience dimension (still computed for the record even though Stage 2 would already have disqualified them)", () => {
    const score = calculateApplicantScore({
      experience: "under_1_year",
      availability: "weekends_only",
      passion: "just_a_job",
      reliableTransport: "no",
      physicalCapability: "no",
    });
    expect(score).toBe(5);
    expect(applicantTierFromScore(score)).toBe("unsuccessful");
  });

  it("treats an entirely empty field set as a zero score", () => {
    const score = calculateApplicantScore({});
    expect(score).toBe(0);
    expect(applicantTierFromScore(score)).toBe("unsuccessful");
  });

  it("caps the score at 100", () => {
    const score = calculateApplicantScore({
      experience: "3_plus_years",
      availability: "flexible",
      passion: "genuinely_passionate",
      reliableTransport: "yes",
      physicalCapability: "yes",
    });
    expect(score).toBeLessThanOrEqual(100);
  });

  it("does not score start_availability, Blue Card status, or insurance/ABN status — non-scoring fields", () => {
    const withExtras = calculateApplicantScore({
      experience: "1_to_3_years",
      availability: "business_hours",
      passion: "take_pride",
      reliableTransport: "yes",
      physicalCapability: "no",
      startAvailability: "immediately",
      blueCardStatus: "current_blue_card_held",
      hasOwnInsuranceAndAbn: "yes",
    });
    const withoutExtras = calculateApplicantScore({
      experience: "1_to_3_years",
      availability: "business_hours",
      passion: "take_pride",
      reliableTransport: "yes",
      physicalCapability: "no",
    });
    expect(withExtras).toBe(withoutExtras);
  });
});
