'use strict';

/**
 * Tool registry for AI Planner agent mode.
 *
 * LaunchDarkly owns each tool's name, description and JSON schema (project
 * tools `get_weather_forecast` and `search_destinations`, attached per agent
 * variation). This file owns the implementations. The LangChain agent runner
 * matches the two by name: a tool declared in LD with no entry here is skipped
 * with a warning, so these keys MUST equal the LD tool keys exactly.
 */

const { getWeatherForecast } = require('./weather');
const { searchDestinations } = require('./catalog');

const TOOL_REGISTRY = {
  get_weather_forecast: getWeatherForecast,
  search_destinations: searchDestinations,
};

module.exports = { TOOL_REGISTRY };
