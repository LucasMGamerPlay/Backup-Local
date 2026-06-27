const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip'); // Nova biblioteca
const cron = require('node-cron');

// ================= CONFIGURAÇÕES =================

// 1. Caminho do arquivo de texto que contém as pastas
const ARQUIVO_PASTAS = path.join(__dirname, 'pastas.txt');

// 2. Pasta onde os backups serão salvos (será criada se não existir)
const PASTA_DESTINO = path.join(__dirname, 'meus_backups');

// 3. Intervalo de tempo (Formato Cron)
// '0 * * * *' = Roda a cada 1 hora.
// '*/30 * * * * *' = Roda a cada 30 segundos (ótimo para testar).
// '0 0 * * *' = Roda todo dia à meia-noite.
const INTERVALO = '*/30 * * * * *'; 

// =================================================

// Garante que a pasta de destino exista
if (!fs.existsSync(PASTA_DESTINO)) {
    fs.mkdirSync(PASTA_DESTINO, { recursive: true });
}

function fazerBackup() {
    console.log('\n--- Iniciando rotina de backup ---');

    if (!fs.existsSync(ARQUIVO_PASTAS)) {
        console.error(`Arquivo de texto não encontrado: ${ARQUIVO_PASTAS}`);
        return;
    }

    const caminhos = fs.readFileSync(ARQUIVO_PASTAS, 'utf-8')
        .split('\n')
        .map(linha => linha.trim())
        .filter(linha => linha.length > 0);

    if (caminhos.length === 0) {
        console.log('Nenhuma pasta encontrada no arquivo.txt');
        return;
    }

    const dataAtual = new Date();
    const dataFormatada = dataAtual.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];

    caminhos.forEach(pastaOrigem => {
        if (!fs.existsSync(pastaOrigem)) {
            console.error(`[ERRO] A pasta não existe: ${pastaOrigem}`);
            return;
        }

        const nomePasta = path.basename(pastaOrigem);
        const nomeArquivoZip = `Backup_${nomePasta}_${dataFormatada}.zip`;
        const caminhoDestinoZip = path.join(PASTA_DESTINO, nomeArquivoZip);

        try {
            console.log(`Compactando ${nomePasta}...`);
            
            // Inicia o processo de ZIP com a nova biblioteca
            const zip = new AdmZip();
            
            // Adiciona todo o conteúdo da pasta original no arquivo
            zip.addLocalFolder(pastaOrigem);
            
            // Salva fisicamente no disco
            zip.writeZip(caminhoDestinoZip);
            
            console.log(`[SUCESSO] Salvo: ${nomeArquivoZip}`);
        } catch (err) {
            console.error(`[ERRO] Falha ao compactar ${nomePasta}:`, err.message);
        }
    });
}

// Inicia o agendador
console.log(`Serviço de backup iniciado. Aguardando o intervalo programado (${INTERVALO})...`);

cron.schedule(INTERVALO, () => {
    fazerBackup();
});

// Descomente a linha abaixo se quiser que ele faça o backup logo que você iniciar o programa, 
// além de esperar o tempo agendado:
// fazerBackup();