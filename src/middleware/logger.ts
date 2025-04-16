// src/middleware/logger.ts
import { Context, MiddlewareHandler, Next } from 'hono';
import { logger } from '../lib/logger';

export interface LoggerOptions {
  logRequestHeaders?: boolean;
  logRequestBody?: boolean;
  logResponseHeaders?: boolean;
  logResponseBody?: boolean;
  excludePaths?: string[];
}

export const loggerMiddleware = (options: LoggerOptions = {}): MiddlewareHandler => {
  return async (c: Context, next: Next) => {
    // Skip logging for excluded paths
    if (options.excludePaths?.some(path => c.req.path.startsWith(path))) {
      await next();
      return;
    }

    const requestStartTime = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const query = c.req.query();
    
    // Log the request
    const requestData: Record<string, any> = {
      method,
      path,
      query: Object.keys(query).length ? query : undefined,
    };

    // Add request headers if enabled
    if (options.logRequestHeaders) {
      const headers: Record<string, string> = {};
      c.req.headers.forEach((value, key) => {
        // Skip sensitive headers
        if (!['authorization', 'cookie'].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      });
      requestData.headers = headers;
    }

    // Add request body if enabled and exists
    if (options.logRequestBody) {
      try {
        const contentType = c.req.header('content-type');
        if (contentType?.includes('application/json')) {
          const body = await c.req.json();
          requestData.body = body;
        }
      } catch (error) {
        // Could not parse body as JSON, skip it
      }
    }

    logger.info('http', `${method} ${path} request received`, requestData);

    try {
      // Process the request
      await next();
      
      // After response is generated
      const responseData: Record<string, any> = {
        status: c.res.status,
        duration: Date.now() - requestStartTime
      };

      // Add response headers if enabled
      if (options.logResponseHeaders) {
        const headers: Record<string, string> = {};
        c.res.headers.forEach((value, key) => {
          headers[key] = value;
        });
        responseData.headers = headers;
      }

      // Add response body if enabled and exists
      if (options.logResponseBody) {
        try {
          const contentType = c.res.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            const text = await c.res.text();
            try {
              responseData.body = JSON.parse(text);
            } catch {
              responseData.body = text;
            }
          }
        } catch (error) {
          // Could not get response body, skip it
        }
      }

      logger.info('http', `${method} ${path} response sent (${c.res.status})`, responseData);
    } catch (error) {
      // Log any errors in request processing
      logger.error('http', `Error processing ${method} ${path}`, {
        error,
        duration: Date.now() - requestStartTime
      });
      throw error;
    }
  };
};