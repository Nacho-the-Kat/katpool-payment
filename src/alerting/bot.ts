import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import Monitoring from '../monitoring';
import path from 'path';

dotenv.config();

const monitoring = new Monitoring();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  monitoring.error('bot: telegram token is undefined');
}

export function isRunningInDocker(): boolean {
  if (process.env.IS_DOCKER === 'true') return true;

  try {
    if (fs.existsSync('/.dockerenv')) return true;
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('kubepods');
  } catch {
    return false;
  }
}

const bot = new TelegramBot(token, { polling: true });

let firstPath = '';
if (isRunningInDocker()) {
  firstPath = '/app/data';
}

const chatIdsFilePath = path.join(firstPath, 'chatIds.json'); // Use volume path
const chatIds = new Set<string>(); // Store unique chat IDs

// Function to load chat IDs from JSON file
const loadChatIds = () => {
  if (fs.existsSync(chatIdsFilePath)) {
    const data = fs.readFileSync(chatIdsFilePath, 'utf-8');
    const ids = JSON.parse(data);
    ids.forEach((id: string) => chatIds.add(id));
  } else {
    // Initialize with an empty array if the file doesn't exist
    fs.writeFileSync(chatIdsFilePath, JSON.stringify([]));
  }
};

// Function to save chat IDs to JSON file
const saveChatIds = () => {
  const idsArray = Array.from(chatIds);
  fs.writeFileSync(chatIdsFilePath, JSON.stringify(idsArray));
};

// Load chat IDs when the bot starts
loadChatIds();

// Listen for 'my_chat_member' updates to detect when the bot is added to a group
bot.on('my_chat_member', update => {
  monitoring.log(`bot: my_chat_member triggered`);
  const { new_chat_member, chat } = update;

  // Check if the bot was added to the group
  if (
    new_chat_member?.status === 'member' ||
    new_chat_member?.status === 'administrator' ||
    chat.type === 'supergroup'
  ) {
    const chatId = chat.id.toString();
    monitoring.log(`bot: Bot is added to a new group.`);
    if (!chatIds.has(chatId)) {
      chatIds.add(chatId);
      monitoring.log(`bot: Adding chat id with my_chat_member event trigger`);
      saveChatIds(); // Save the new chat ID to JSON file
      sendWelcomeMsg(chatId);
    }
  }
});

bot.on('message', msg => {
  const chatId = msg.chat.id.toString();

  if ((msg.chat.type === 'supergroup' || msg.chat.type === 'group') && !chatIds.has(chatId)) {
    monitoring.log(`bot: Detected in group: ${chatId}`);
    chatIds.add(chatId);
    saveChatIds();
    sendWelcomeMsg(chatId);
  }
});

function sendWelcomeMsg(chatId: any) {
  bot.sendMessage(chatId, `Thank you for adding Katpool alert bot to your group`);
}

// Function to send message to all saved chat IDs
export const sendTelegramAlert = (message: string) => {
  chatIds.forEach(chatId => {
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  });
};

export default bot;
