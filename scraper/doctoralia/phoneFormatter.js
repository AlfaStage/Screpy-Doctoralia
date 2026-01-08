/**
 * Formata números de telefone brasileiros para o formato E.164
 * Formato E.164: +[código do país][código de área][número]
 * Exemplo: +5511999999999
 * 
 * @param {string} phone - Número de telefone em qualquer formato
 * @returns {string} - Número formatado em E.164 ou string vazia se inválido
 */
function formatToE164(phone) {
    if (!phone || typeof phone !== 'string') {
        return '';
    }

    // Remove todos os caracteres não numéricos
    let digits = phone.replace(/\D/g, '');

    // Se começar com '0' (comum em números brasileiros com DDD), remove
    if (digits.startsWith('0')) {
        digits = digits.substring(1);
    }

    // Valida se tem pelo menos 10 dígitos (XX XXXX-XXXX ou XX XXXXX-XXXX)
    if (digits.length < 10) {
        return '';
    }

    // Se não começar com '55' (código do Brasil), adiciona
    if (!digits.startsWith('55')) {
        // Se tem 10 ou 11 dígitos, é um número sem código de país
        if (digits.length === 10 || digits.length === 11) {
            digits = '55' + digits;
        }
    }

    // Valida o comprimento final (deve ter 12 ou 13 dígitos: 55 + DDD + número)
    // 12 dígitos: 55 + 2 (DDD) + 8 (fixo)
    // 13 dígitos: 55 + 2 (DDD) + 9 (celular)
    if (digits.length !== 12 && digits.length !== 13) {
        return '';
    }

    // Retorna no formato E.164 com o sinal de +
    return '+' + digits;
}

/**
 * Verifica se um número está no formato E.164 válido
 * @param {string} phone - Número para verificar
 * @returns {boolean}
 */
function isValidE164(phone) {
    if (!phone || typeof phone !== 'string') {
        return false;
    }

    // Formato E.164 brasileiro válido:
    // +55 (código do Brasil) + 2 dígitos DDD + 8-9 dígitos do número
    const e164Regex = /^\+55\d{10,11}$/;
    return e164Regex.test(phone);
}

/**
 * Formata um objeto de perfil, convertendo seus números para E.164
 * @param {Object} profileData - Dados do perfil com numeroFixo e numeroMovel
 * @returns {Object} - Perfil com números formatados
 */
function formatProfilePhones(profileData) {
    if (!profileData) {
        return profileData;
    }

    const formatted = { ...profileData };

    if (formatted.numeroFixo) {
        formatted.numeroFixo = formatToE164(formatted.numeroFixo);
    }

    if (formatted.numeroMovel) {
        formatted.numeroMovel = formatToE164(formatted.numeroMovel);
    }

    return formatted;
}

module.exports = {
    formatToE164,
    isValidE164,
    formatProfilePhones
};
