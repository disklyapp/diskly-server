import { Telegraf } from 'telegraf';

export let bot: Telegraf;

export const initBot = (token: string): Telegraf => {
  bot = new Telegraf(token);
  return bot;
};
