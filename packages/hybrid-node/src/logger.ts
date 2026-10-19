import winston from 'winston';

export function createLogger(nodeLabel: string) {
  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] [${nodeLabel}] ${level}: ${message}${metaStr}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: `logs/${nodeLabel}.log` }),
    ],
  });
}
