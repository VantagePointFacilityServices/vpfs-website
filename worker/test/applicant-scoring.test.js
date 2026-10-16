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
    for (const postcode of ["4207", "4211", "4217", "4225", "4230", "2484", "2485", "2490"]) {
      expect(checkApplicantAreaDisqualifier({ postcode })).toEqual({ disqualified: false, reason: null });
    }
  });

  it("flags a postcode outside the applicant area", () => {
    // 2483 is mostly Byron Shire; 4270-4275 is mostly Scenic Rim (Blake, 2026-10-13).
    for (const postcode of ["9999", "4000", "4206", "4231", "2483", "2491", "4270", "4272", "4275"]) {
      expect(checkApplicantAreaDisqualifier({ postcode })).toEqual({
        disqualified: true,
        reason: "unsuccessful-out-of-area",
      });
    }
    expect(APPLICANT_POSTCODES).toHaveLength(31);
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

describe("residential experience", () => {
  const base = {
    experience: "under_1_year",
    residentialExperience: "1_to_3_years",
    rightToWork: "yes",
    policeCheckStatus: "willing_no_current_check",
    postcode: "4211",
  };

  it("commercial under 1 year + residential 1-3 years is not disqualified", () => {
    expect(checkApplicantDisqualifiers("employee", base).disqualified).toBe(false);
  });

  it.each([
    ["none", "none"],
    ["under_1_year", "none"],
    ["none", "under_1_year"],
    ["under_1_year", "under_1_year"],
  ])("commercial %s + residential %s -> insufficient experience", (experience, residentialExperience) => {
    expect(checkApplicantDisqualifiers("employee", { ...base, experience, residentialExperience }).reason).toBe(
      "unsuccessful-insufficient-experience"
    );
  });

  it("residential points: employee 20/35, subcontractor 20/28/35", () => {
    const emp = (r) => applicantScore("employee", { residentialExperience: r });
    expect([emp("under_1_year"), emp("1_to_3_years"), emp("3_plus_years")]).toEqual([0, 20, 35]);
    const sub = (r) => applicantScore("subcontractor", { residentialExperience: r });
    expect([sub("under_1_year"), sub("1_to_3_years"), sub("3_to_5_years"), sub("5_plus_years")]).toEqual([0, 20, 28, 35]);
  });

  it("experience scores the higher of commercial and residential", () => {
    expect(applicantScore("employee", { experience: "3_plus_years", residentialExperience: "none" })).toBe(55);
    expect(applicantScore("employee", { experience: "1_to_3_years", residentialExperience: "3_plus_years" })).toBe(35);
    expect(applicantScore("employee", { experience: "under_1_year", residentialExperience: "1_to_3_years" })).toBe(20);
    expect(applicantScore("subcontractor", { experience: "5_plus_years", residentialExperience: "5_plus_years" })).toBe(60);
    expect(applicantScore("subcontractor", { experience: "under_1_year", residentialExperience: "3_to_5_years" })).toBe(28);
  });
});

describe("applicantScore", () => {
  it("employee experience: 1-3 yrs 35, 3+ yrs 55", () => {
    const only = (experience) => applicantScore("employee", { experience });
    expect(only("1_to_3_years")).toBe(35);
    expect(only("3_plus_years")).toBe(55);
    expect(applicantScore("employee", { experience: "3_plus_years", availability: "flexible", reliableTransport: "yes" })).toBe(100);
  });

  it("subcontractor experience: 1-3 yrs 35, 3-5 yrs 48, 5+ yrs 60", () => {
    const only = (experience) => applicantScore("subcontractor", { experience });
    expect(only("1_to_3_years")).toBe(35);
    expect(only("3_to_5_years")).toBe(48);
    expect(only("5_plus_years")).toBe(60);
    expect(only("3_plus_years")).toBe(0); // not a subcontractor option
  });

  it("availability is per-track", () => {
    const emp = (a) => applicantScore("employee", { availability: a });
    const sub = (a) => applicantScore("subcontractor", { availability: a });
    const order = ["weekends_only", "business_hours", "after_hours", "flexible"];
    expect(order.map(emp)).toEqual([5, 10, 25, 30]);
    expect(order.map(sub)).toEqual([8, 15, 32, 40]);
  });

  it("transport scores 15 for an employee and nothing for a subcontractor", () => {
    expect(applicantScore("employee", { reliableTransport: "yes" })).toBe(15);
    expect(applicantScore("employee", { reliableTransport: "no" })).toBe(0);
    expect(applicantScore("subcontractor", { reliableTransport: "yes" })).toBe(0);
  });

  it("ignores removed fields", () => {
    const f = { experience: "1_to_3_years", availability: "weekends_only", passion: "genuinely_passionate", physicalCapability: "yes", worksForOtherClients: "yes" };
    expect(applicantScore("employee", f)).toBe(40);
    expect(applicantScore("subcontractor", f)).toBe(43);
  });

  it("caps at 100 and scores an empty field set at zero", () => {
    expect(applicantScore("subcontractor", { experience: "5_plus_years", availability: "flexible" })).toBe(100);
    expect(applicantScore("employee", {})).toBe(0);
  });

  // PRD v3 D5 worked examples
  it.each([
    ["employee", { experience: "3_plus_years", residentialExperience: "none", availability: "weekends_only", reliableTransport: "yes" }, 75, "priority"],
    ["employee", { experience: "1_to_3_years", residentialExperience: "none", availability: "business_hours", reliableTransport: "yes" }, 60, "standard"],
    ["employee", { experience: "1_to_3_years", residentialExperience: "none", availability: "weekends_only", reliableTransport: "no" }, 40, "standard"],
    ["employee", { experience: "under_1_year", residentialExperience: "1_to_3_years", availability: "weekends_only", reliableTransport: "no" }, 25, "unsuccessful"],
    ["subcontractor", { experience: "3_to_5_years", residentialExperience: "none", availability: "after_hours" }, 80, "priority"],
    ["subcontractor", { experience: "1_to_3_years", residentialExperience: "none", availability: "after_hours" }, 67, "standard"],
    ["subcontractor", { experience: "1_to_3_years", residentialExperience: "none", availability: "weekends_only" }, 43, "standard"],
    ["subcontractor", { experience: "under_1_year", residentialExperience: "1_to_3_years", availability: "weekends_only" }, 28, "unsuccessful"],
  ])("D5 example: %s %j -> %i %s", (track, f, score, tier) => {
    const s = applicantScore(track, f);
    expect(s).toBe(score);
    expect(applicantTierFromScore(s)).toBe(tier);
  });

  it.each(["employee", "subcontractor"])("%s: 1+ year commercial, no disqualifier -> at least 30", (track) => {
    const levels = track === "employee" ? ["1_to_3_years", "3_plus_years"] : ["1_to_3_years", "3_to_5_years", "5_plus_years"];
    for (const experience of levels) {
      for (const availability of ["weekends_only", "business_hours", "after_hours", "flexible"]) {
        for (const reliableTransport of ["yes", "no"]) {
          expect(applicantScore(track, { experience, availability, reliableTransport })).toBeGreaterThanOrEqual(30);
        }
      }
    }
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
