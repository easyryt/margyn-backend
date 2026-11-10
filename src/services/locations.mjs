import {
  getStatesOfCountry,
  getCitiesOfState,
} from "@countrystatecity/countries";
import { AppError } from "./errors.mjs";

// Offline package data stays in the Express backend; only India options go to the browser.
export const LOCATION_ATTRIBUTION = {
  name: "CSC Database",
  source:
    "https://github.com/dr5hn/countrystatecity-npm/tree/main/packages/countries",
  license: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
};
let statesPromise;
const citiesByState = new Map();

export function listIndianStates() {
  statesPromise ??= getStatesOfCountry("IN")
    .then((states) =>
      states
        .map(({ name, iso2 }) => ({ name, code: iso2 }))
        .sort((a, b) => a.name.localeCompare(b.name, "en")),
    )
    .catch((error) => {
      statesPromise = undefined;
      throw error;
    });
  return statesPromise;
}

export async function listIndianCities(stateCode) {
  const states = await listIndianStates();
  if (
    typeof stateCode !== "string" ||
    !states.some(({ code }) => code === stateCode)
  )
    throw new AppError("Choose a valid Indian state or union territory.");
  if (!citiesByState.has(stateCode)) {
    citiesByState.set(
      stateCode,
      getCitiesOfState("IN", stateCode)
        .then((cities) =>
          [...new Set(cities.map(({ name }) => name))].sort((a, b) =>
            a.localeCompare(b, "en"),
          ),
        )
        .catch((error) => {
          citiesByState.delete(stateCode);
          throw error;
        }),
    );
  }
  return citiesByState.get(stateCode);
}
