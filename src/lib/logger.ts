// src/lib/logger.ts
import fs from 'fs';
import path from 'path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  logToConsole?: boolean;
  logToFile?: boolean;
  logDir?: string;
  logFileName?: string;
}

export class Logger {
  private options: LoggerOptions;
  private logFilePath: string;

  constructor(options: LoggerOptions = {}) {
    this.options = {
      minLevel: LogLevel.INFO,
      logToConsole: true,
      logToFile: true,
      logDir: './logs',
      logFileName: 'app.log',
      ...options
    };

    // Ensure log directory exists
    if (this.options.logToFile) {
      fs.mkdirSync(this.options.logDir!, { recursive: true });
      this.logFilePath = path.join(this.options.logDir!, this.options.logFileName!);
    }
  }

  public debug(module: string, message: string, data?: any): void {
    this.log(LogLevel.DEBUG, module, message, data);
  }

  public info(module: string, message: string, data?: any): void {
    this.log(LogLevel.INFO, module, message, data);
  }

  public warn(module: string, message: string, data?: any): void {
    this.log(LogLevel.WARN, module, message, data);
  }

  public error(module: string, message: string, data?: any): void {
    this.log(LogLevel.ERROR, module, message, data);
  }

  private log(level: LogLevel, module: string, message: string, data?: any): void {
    if (level < this.options.minLevel!) {
      return;
    }

    const timestamp = new Date().toISOString();
    const logEntry: LogEntry = {
      timestamp,
      level,
      module,
      message,
      data
    };

    // Log to console if enabled
    if (this.options.logToConsole) {
      this.logToConsole(logEntry);
    }

    // Log to file if enabled
    if (this.options.logToFile) {
      this.logToFile(logEntry);
    }
  }

  private logToConsole(entry: LogEntry): void {
    const levelStr = LogLevel[entry.level];
    let consoleMethod: Function;
    
    switch (entry.level) {
      case LogLevel.DEBUG:
        consoleMethod = console.debug;
        break;
      case LogLevel.INFO:
        consoleMethod = console.info;
        break;
      case LogLevel.WARN:
        consoleMethod = console.warn;
        break;
      case LogLevel.ERROR:
        consoleMethod = console.error;
        break;
      default:
        consoleMethod = console.log;
    }

    const formattedData = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    consoleMethod(`[${entry.timestamp}] [${levelStr}] [${entry.module}] ${entry.message}${formattedData}`);
  }

  private logToFile(entry: LogEntry): void {
    const levelStr = LogLevel[entry.level];
    const formattedData = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    const logLine = `[${entry.timestamp}] [${levelStr}] [${entry.module}] ${entry.message}${formattedData}\n`;
    
    fs.appendFileSync(this.logFilePath, logLine);
  }

  // Query logs from file based on criteria
  public async queryLogs(options: {
    level?: LogLevel,
    module?: string,
    startTime?: Date,
    endTime?: Date,
    limit?: number
  }): Promise<LogEntry[]> {
    if (!this.options.logToFile) {
      return [];
    }

    try {
      const logContent = await fs.promises.readFile(this.logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim());
      
      // Parse log lines and filter based on criteria
      const logs: LogEntry[] = [];
      
      for (const line of logLines) {
        try {
          // Basic regex to extract parts of the log line
          const match = line.match(/\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] (.+?)(?:\s(\{.+\}))?$/);
          
          if (match) {
            const [, timestamp, levelStr, module, message, dataStr] = match;
            const level = LogLevel[levelStr as keyof typeof LogLevel];
            const data = dataStr ? JSON.parse(dataStr) : undefined;
            
            const entry: LogEntry = { timestamp, level, module, message, data };
            
            // Apply filters
            if (options.level !== undefined && entry.level < options.level) continue;
            if (options.module && entry.module !== options.module) continue;
            if (options.startTime && new Date(entry.timestamp) < options.startTime) continue;
            if (options.endTime && new Date(entry.timestamp) > options.endTime) continue;
            
            logs.push(entry);
            
            if (options.limit && logs.length >= options.limit) break;
          }
        } catch (error) {
          // Skip malformed log lines
          continue;
        }
      }
      
      return logs;
    } catch (error) {
      console.error('Error querying logs:', error);
      return [];
    }
  }
}

// Create a default logger instance
export const logger = new Logger();