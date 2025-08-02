import fs from "fs";

enum EnvState {
  PROD = "production",
  DEV = "development",
  STAGE = "staging",
}

const isProduction = () => process.env.NODE_ENV === EnvState.PROD;

const isDevelopment = () => process.env.NODE_ENV === EnvState.DEV;

const isLocal = () => !isProduction() && !isDevelopment();

const getEnvFileName = () => {
  const envName = process.env.NODE_ENV;
  if (fs.existsSync(`.env.${envName || "local"}`)) {
    return `.env.${envName || "local"}`;
  }
};

export { getEnvFileName, isDevelopment, isLocal, isProduction };
