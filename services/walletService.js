const axios = require('axios');
require('dotenv').config();

async function verifyDeposit(txHash) {
  try {
    const cleanHash = String(txHash).trim();

    // ИСПРАВЛЕНО: Корректный URL-путь и шаблонная строка (${cleanHash}) для TronScan API
    const headers = {};
    if (process.env.TRONGRID_API_KEY || process.env.TRONSCAN_API_KEY) {
      headers['TRON-PRO-API-KEY'] = process.env.TRONSCAN_API_KEY || process.env.TRONGRID_API_KEY;
    }

    const response = await axios.get(
      `https://apilist.tronscanapi.com/api/transaction-info?hash=${encodeURIComponent(cleanHash)}`,
      { headers, timeout: 10000 }
    );

    const tx = response.data;

    // 1. Проверяем статус транзакции в блокчейне
    if (!tx || tx.contractRet !== 'SUCCESS' || tx.confirmed !== true) {
      return { success: false, reason: 'Транзакция не подтверждена или завершилась ошибкой' };
    }

    // 2. Проверяем, что это вызов смарт-контракта
    const contractType = tx.contractType;
    if (contractType !== 'TriggerSmartContract' && contractType !== 31) {
      return { success: false, reason: 'Неверный тип транзакции' };
    }

    // 3. Проверяем адрес смарт-контракта (строго официальный USDT TRC20)
    const usdtContractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    if (tx.toAddress !== usdtContractAddress) {
      return { success: false, reason: 'Транзакция отправлена не на контракт USDT' };
    }

    // 4. Достаем параметры перевода внутри смарт-контракта
    // Поддерживаем как реальный ответ TronScan (trigger_info), так и triggerAttribute
    const triggerData = tx.trigger_info || tx.triggerAttribute;
    const methodName = triggerData?.methodName || triggerData?.method;

    if (
      !triggerData ||
      (methodName !== 'transfer(address,uint256)' && methodName !== 'transfer')
    ) {
      return { success: false, reason: 'Метод вызова не является переводом токенов' };
    }

    const params = triggerData.parameter || {};
    const recipientAddress = params['_to'] || params['to'];
    const rawAmount = parseInt(params['_value'] || params['value'], 10);

    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      return { success: false, reason: 'Некорректная сумма транзакции' };
    }

    // 5. Проверяем адрес получателя (кошелек казино)
    if (recipientAddress !== process.env.TRON_WALLET_ADDRESS) {
      return { success: false, reason: 'Получатель транзакции не совпадает с кошельком казино' };
    }

    // 6. Конвертируем сумму из micro-units (USDT decimals = 6)
    const finalAmount = rawAmount / 1000000;

    return {
      success: true,
      amount: finalAmount
    };

  } catch (error) {
    console.error('TronScan Verification Error:', error.message);
    return { success: false, reason: 'Ошибка связи с API блокчейна' };
  }
}

module.exports = { verifyDeposit };
