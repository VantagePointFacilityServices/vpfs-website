import { describe, it, expect } from "vitest";
import {
  checkApplicantAreaDisqualifier,
  checkApplicantDisqualifiers,
  applicantScore,
  applicantTierFromScore,
  APPLICANT_POSTCODES,
} from "../worker.js";

describe("checkApplicantAreaDisqualifier", () => {
  it("passes Gold Coast and Tweed postcodes, including ones outside SERVICE_POSTCODES", () => {
    for (const postcode of ["4211", "4217", "4225", "4230", "2485", "2490"]) {
      expect(checkApplicantAreaDisqualifier({ postcode })).toEqual({ disqualified: false, reason: null });
    }
  });

  it("flags a postcode outside the applicant area", () => {
    for (const postcode of ["9999", "4000", "4206", "4231", "2484", "2491"]) {
      expect(checkApplicantAreaDisqualifier({ postcode })).toEqual({
        disqualified: true,
        reason: "unsuccessful-out-of-area",
      });
    }
    expect(APPLICANT_POSTCODES).toHaveLength(30);
  });

  it("does not disqualify on a missing postcode", () => {
    expect(checkApplicantAreaDisqualifier({ postcode: "" }).disqualified).toBe(false);
  });
});

describe("checkApplicantDisqualifiers", () => {
  const base = {
    experience: "1_to_3_years",
    rightToWork: "yes",
    policeCheckStatus: "willing_no_current_check",
    postcode: "4211",
    hasOwnInsuranceAndAbn: "yes",
    ownEquipment: "yes",
    reliableTransport: "yes",
  };

  it.each(["employee", "subcontractor"])("%s: passes a clean applicant", (track) => {
    expect(checkApplicantDisqualifiers(track, base)).toEqual({ disqualified: false, reason: null });
  });

  it("only the subcontractor track enforces ABN, equipment and transport", () => {
    const f = { ...base, hasOwnInsuranceAndAbn: "no", ownEquipment: "no", reliableTransport: "no" };
    expect(checkApplicantDisqualifiers("employee", f).disqualified).toBe(false);
    expect(checkApplicantDisqualifiers("subcontractor", f).reason).toBe("unsuccessful-no-abn-redirect-careers");
  });

  it("checks in the D18 order", () => {
    expect(checkApplicantDisqualifiers("employee", { ...base, experience: "none", rightToWork: "no" }).reason).toBe(
      "unsuccessful-insufficient-experience"
    );
    expect(
      checkApplicantDisqualifiers("employee", { ...base, rightToWork: "no", policeCheckStatus: "not_willing" }).reason
    ).toBe("unsuccessful-no-right-to-work");
  });

  it("never disqualifies on holding a current police check or on Blue Card status", () => {
    expect(
      checkApplicantDisqualifiers("employee", { ...base, policeCheckStatus: "current_check_held", blueCardStatus: "not_applicable" })
        .disqualified
    ).toBe(false);
  });
});

describe("applicantScore", () => {
  const strong = {
    availability: "flexible",
    passion: "genuinely_passionate",
    reliableTransport: "yes",
    physicalCapability: "yes",
    worksForOtherClients: "yes",
  };

  it("employee experience: 1-3 yrs 25, 3+ yrs 40 (weights otherwise as today)", () => {
    expect(applicantScore("employee", { ...strong, experience: "3_plus_years" })).toBe(100);
    expect(
      applicantScore("employee", {
        experience: "1_to_3_years",
        availability: "business_hours",
        passion: "take_pride",
        reliableTransport: "yes",
        physicalCapability: "no",
      })
    ).toBe(55);
  });

  it("subcontractor experience: 1-3 yrs 25, 3-5 yrs 32, 5+ yrs 40", () => {
    const only = (experience) => applicantScore("subcontractor", { experience });
    expect(only("1_to_3_years")).toBe(25);
    expect(only("3_to_5_years")).toBe(32);
    expect(only("5_plus_years")).toBe(40);
    expect(only("3_plus_years")).toBe(0); // not a subcontractor option
  });

  it("works for other clients scores 15/0 on the subcontractor track; employee scores transport", () => {
    const sub = (v) => applicantScore("subcontractor", { works_ignored: 1, worksForOtherClients: v, reliableTransport: "yes" });
    expect(sub("yes")).toBe(15);
    expect(sub("no")).toBe(0);
    expect(applicantScore("employee", { reliableTransport: "yes", worksForOtherClients: "yes" })).toBe(15);
    expect(applicantScore("employee", { reliableTransport: "no", worksForOtherClients: "yes" })).toBe(0);
  });

  it("caps at 100 and scores an empty field set at zero", () => {
    expect(applicantScore("subcontractor", { ...strong, experience: "5_plus_years" })).toBeLessThanOrEqual(100);
    expect(applicantScore("employee", {})).toBe(0);
  });
});

describe("applicantTierFromScore", () => {
  it("keeps the cut-offs: priority >= 70, standard 30-69, else unsuccessful", () => {
    expect(applicantTierFromScore(70)).toBe("priority");
    expect(applicantTierFromScore(69)).toBe("standard");
    expect(applicantTierFromScore(30)).toBe("standard");
    expect(applicantTierFromScore(29)).toBe("unsuccessful");
  });
});
