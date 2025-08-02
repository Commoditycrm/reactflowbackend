import { createLogger, format, transports } from "winston";

const productionLogger = () => {
  const { timestamp, combine, printf, json } = format;
  const myFormat = printf(({ level, message, timestamp }) => {
    return `[${level}]:${timestamp} ${message} `;
  });
  return createLogger({
    level: "info",
    format: combine(
      timestamp({ format: "YYYY-MM-DD HH:MM:SS" }),
      myFormat,
      json()
    ),
    transports: [
      new transports.Console(),
      new transports.File({ filename: "myErrors.log" }),
    ],
  });
};
export default productionLogger;
