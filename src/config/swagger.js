import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('swagger');

// Swagger definition
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'SwapMyLook API',
    version: '1.0.0',
    description: 'API documentation for SwapMyLook - AI-powered outfit changing application',
    contact: {
      name: 'SwapMyLook Team',
      email: 'support@swapmylook.com'
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT'
    }
  },
  servers: [
    {
      url: process.env.APP_URL || 'http://localhost:3001',
      description: process.env.NODE_ENV === 'production' ? 'Production server' : 'Development server'
    }
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token in the format: Bearer <token>'
      }
    },
    schemas: {
      // Common schemas
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              code: { type: 'string' },
              details: { type: 'object' }
            }
          }
        }
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string' },
          avatarUrl: { type: 'string', format: 'uri' },
          plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          quota: {
            type: 'object',
            properties: {
              monthlyRequests: { type: 'integer' },
              usedThisMonth: { type: 'integer' },
              remaining: { type: 'integer' },
              resetDate: { type: 'string', format: 'date-time' }
            }
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      ImageAsset: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['model', 'outfit', 'output', 'thumbnail'] },
          url: { type: 'string', format: 'uri' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          mimeType: { type: 'string' },
          sizeBytes: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          metadata: { type: 'object' }
        }
      },
      JobRecord: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { 
            type: 'string', 
            enum: ['queued', 'processing', 'succeeded', 'failed', 'cancelled'] 
          },
          prompt: { type: 'string' },
          options: { type: 'object' },
          attempts: { type: 'integer' },
          error: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time' },
          processingTime: { type: 'integer' }
        }
      }
    },
    responses: {
      UnauthorizedError: {
        description: 'Authentication token is missing or invalid',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Error'
            }
          }
        }
      },
      ValidationError: {
        description: 'Invalid request data',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Error'
            }
          }
        }
      },
      NotFoundError: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Error'
            }
          }
        }
      }
    }
  },
  tags: [
    {
      name: 'Authentication',
      description: 'User authentication and authorization endpoints'
    },
    {
      name: 'Uploads',
      description: 'File upload and management endpoints'
    },
    {
      name: 'Assets',
      description: 'Image asset management endpoints'
    },
    {
      name: 'Generation',
      description: 'AI image generation endpoints'
    },
    {
      name: 'Gallery',
      description: 'User gallery and output management'
    },
    {
      name: 'Admin',
      description: 'Administrative endpoints (requires admin privileges)'
    },
    {
      name: 'Health',
      description: 'Service health and monitoring endpoints'
    }
  ]
};

// Options for swagger-jsdoc
const options = {
  swaggerDefinition,
  apis: [
    './src/routes/*.js',
    './src/models/*.js'
  ],
};

// Initialize swagger-jsdoc
const swaggerSpec = swaggerJsdoc(options);

// Swagger UI setup
function setupSwagger(app) {
  // Serve Swagger UI
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'SwapMyLook API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'none'
    }
  }));

  // Serve raw Swagger JSON
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });

  logger.info('Swagger documentation available at /api-docs');
}

export { setupSwagger, swaggerSpec };