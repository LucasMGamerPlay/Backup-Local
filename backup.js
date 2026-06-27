const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip'); // Nova biblioteca
const cron = require('node-cron');

// ================= CONFIGURAÇÕES =================

// 1. Caminho do arquivo de texto que contém as pastas
const ARQUIVO_PASTAS = path.join(__dirname, 'pastas.txt');
// 2. Pasta onde os backups serão salvos (será criada se não existir)
const ARQUIVO_DESTINO = path.join(__dirname, 'destino.txt'); 
// Pasta de segurança caso o txt esteja vazio
const PASTA_PADRAO = path.join(__dirname, 'meus_backups'); 

// 3. Intervalo de tempo (Formato Cron)
// '0 * * * *' = Roda a cada 1 hora.
// '*/30 * * * * *' = Roda a cada 30 segundos (ótimo para testar).
// '0 0 * * *' = Roda todo dia à meia-noite.
const INTERVALO = '0 * * * *'; 

//Quantos dias os backups devem ser mantidos?
const DIAS_RETENCAO = 4;

// =============================================================

function obterPastaDestino() {
    let destino = '';

    if (fs.existsSync(ARQUIVO_DESTINO)) {
        const conteudo = fs.readFileSync(ARQUIVO_DESTINO, 'utf-8').split('\n')[0];
        if (conteudo) {
            destino = conteudo.trim();
        }
    }

    if (!destino) {
        console.log(`\n[SISTEMA] Arquivo destino.txt vazio ou inexistente. Assumindo rota de segurança: ${PASTA_PADRAO}`);
        destino = PASTA_PADRAO;
        fs.writeFileSync(ARQUIVO_DESTINO, PASTA_PADRAO, 'utf-8');
    }

    if (!fs.existsSync(destino)) {
        try {
            fs.mkdirSync(destino, { recursive: true });
            console.log(`[SISTEMA] A pasta de destino foi criada no disco: ${destino}`);
        } catch (err) {
            console.error(`[ERRO] Não foi possível criar a pasta de destino ${destino}:`, err.message);
            return null;
        }
    }

    return destino;
}

function limparBackupsAntigos(pastaDestino) {
    console.log('\n--- Verificando backups antigos para limpeza ---');
    
    if (!fs.existsSync(pastaDestino)) return;

    const arquivos = fs.readdirSync(pastaDestino);
    const tempoAtual = Date.now();
    const tempoLimiteEmMilissegundos = DIAS_RETENCAO * 24 * 60 * 60 * 1000;
    let apagados = 0;

    arquivos.forEach(arquivo => {
        if (path.extname(arquivo) !== '.zip') return;

        const caminhoArquivo = path.join(pastaDestino, arquivo);
        const informacoesArquivo = fs.statSync(caminhoArquivo);
        const idadeDoArquivo = tempoAtual - informacoesArquivo.mtimeMs;

        if (idadeDoArquivo > tempoLimiteEmMilissegundos) {
            try {
                fs.unlinkSync(caminhoArquivo);
                console.log(`[LIXEIRA] Backup antigo removido: ${arquivo}`);
                apagados++;
            } catch (err) {
                console.error(`[ERRO] Não foi possível apagar ${arquivo}:`, err.message);
            }
        }
    });

    if (apagados === 0) {
        console.log('[INFO] Nenhum backup antigo precisou ser apagado neste ciclo.');
    }
}

function fazerBackup() {
    console.log('\n=================================================');
    console.log('--- INICIANDO NOVO CICLO DE BACKUP ---');

    const pastaDestinoAtual = obterPastaDestino();
    
    if (!pastaDestinoAtual) {
        console.error('[ABORTADO] Backup não realizado por erro na pasta de destino.');
        return;
    }

    if (!fs.existsSync(ARQUIVO_PASTAS)) {
        console.error(`[ERRO] Arquivo de texto de origem não encontrado: ${ARQUIVO_PASTAS}`);
        return;
    }

    const caminhos = fs.readFileSync(ARQUIVO_PASTAS, 'utf-8')
        .split('\n')
        .map(linha => linha.trim())
        .filter(linha => linha.length > 0);

    if (caminhos.length === 0) {
        console.log('[AVISO] Nenhuma pasta de origem encontrada no arquivo pastas.txt. Preencha o arquivo.');
        return;
    }

    const dataAtual = new Date();
    const dataFormatada = dataAtual.toISOString().replace(/T/, '_').replace(/:/g, '-').split('.')[0];

    caminhos.forEach(pastaOrigem => {
        if (!fs.existsSync(pastaOrigem)) {
            console.error(`[ERRO] A pasta de origem não existe e será ignorada: ${pastaOrigem}`);
            return;
        }

        const nomePasta = path.basename(pastaOrigem);
        const nomeArquivoZip = `Backup_${nomePasta}_${dataFormatada}.zip`;
        const caminhoDestinoZip = path.join(pastaDestinoAtual, nomeArquivoZip);

        try {
            console.log(`\nCompactando: ${nomePasta}...`);
            const zip = new AdmZip();
            zip.addLocalFolder(pastaOrigem);
            zip.writeZip(caminhoDestinoZip);
            console.log(`[SUCESSO] Salvo em: ${caminhoDestinoZip}`);
        } catch (err) {
            console.error(`[ERRO] Falha ao compactar ${nomePasta}:`, err.message);
        }
    });

    // Executa a limpeza
    limparBackupsAntigos(pastaDestinoAtual);

    // ================= NOVO PAINEL DE RESUMO =================
    console.log('\n--- RESUMO DAS CONFIGURAÇÕES ATUAIS ---');
    console.log(`📅 Intervalo do Cron: ${INTERVALO}`);
    console.log(`🗑️  Dias de Retenção: ${DIAS_RETENCAO} dias`);
    console.log(`📂 Destino Atual: ${pastaDestinoAtual}`);
    console.log(`📁 Pastas Monitoradas (${caminhos.length}):`);
    caminhos.forEach(pasta => console.log(`   - ${pasta}`));
    console.log('=================================================\n');
}

console.log(`Serviço de backup iniciado. Aguardando o intervalo programado (${INTERVALO})...`);

cron.schedule(INTERVALO, () => {
    fazerBackup();
});