import type { IncomingMessage, ServerResponse } from 'node:http';

import { Controller, Delete, Get, Inject, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import { type NodeMcpRequestHandler, toNodeHandler } from '@modelcontextprotocol/node';

import { Public } from '../../identity/decorators/public.decorator';
import { MCP_PRINCIPAL, McpBearerGuard, McpGrantThrottlerGuard } from '../mcp-bearer.guard';
import { McpOAuthService, type McpPrincipal } from '../oauth/mcp-oauth.service';
import { McpServerFactory } from '../server/mcp-server.factory';

type McpHttpRequest = IncomingMessage & {
  [MCP_PRINCIPAL]?: McpPrincipal;
  auth?: AuthInfo;
  body?: unknown;
};

/**
 * The MCP endpoint (spec 046): Streamable HTTP, stateless — every POST is served by a fresh server
 * built for the request's principal, so any API replica can answer any request and nothing about
 * a connection lives in memory between calls. GET and DELETE (2025-era session operations) get the
 * SDK's 405.
 *
 * The address limit is raised far above the app-wide one: hosted clients share egress addresses,
 * so `McpGrantThrottlerGuard`'s per-grant budget is the real one.
 */
@ApiExcludeController()
@ApiBearerAuth()
@Public()
@UseGuards(McpBearerGuard, McpGrantThrottlerGuard)
@Throttle({ default: { limit: 3_000, ttl: 60_000 } })
@Controller({ path: 'mcp', version: '1' })
export class McpController {
  private readonly logger = new Logger(McpController.name);
  private readonly handle: NodeMcpRequestHandler;

  constructor(
    @Inject(McpServerFactory) servers: McpServerFactory,
    @Inject(McpOAuthService) private readonly oauth: McpOAuthService,
  ) {
    const handler = createMcpHandler(
      ({ authInfo }) => servers.build(authInfo?.extra?.principal as McpPrincipal),
      { onerror: (error) => this.logger.warn(`mcp request rejected: ${error.message}`) },
    );
    this.handle = toNodeHandler(handler);
  }

  /** GET and DELETE are 2025-era session operations; the SDK answers them 405 when stateless. */
  @Get()
  async streams(@Req() request: McpHttpRequest, @Res() response: ServerResponse): Promise<void> {
    await this.serve(request, response);
  }

  @Delete()
  async sessions(@Req() request: McpHttpRequest, @Res() response: ServerResponse): Promise<void> {
    await this.serve(request, response);
  }

  @Post()
  async serve(@Req() request: McpHttpRequest, @Res() response: ServerResponse): Promise<void> {
    const principal = request[MCP_PRINCIPAL]!;
    request.auth = {
      clientId: principal.clientId,
      expiresAt: Math.floor(principal.expiresAt.getTime() / 1_000),
      extra: { principal },
      resource: new URL(this.oauth.urls.resource),
      scopes: [...principal.scopes],
      token: 'verified',
    };
    // `compression` would buffer the SSE stream progress notifications ride on until it ended.
    delete request.headers['accept-encoding'];
    response.setHeader('X-Accel-Buffering', 'no');

    await this.handle(request, response, request.body);
  }
}
