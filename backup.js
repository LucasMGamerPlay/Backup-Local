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
//Limite mínimo de espaço livre no disco (em Gigabytes)
const LIMITE_ESPACO_LIVRE_GB = 1;

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
    console.log('\n--- Verificando lixeira e espaço em disco ---');
    
    if (!fs.existsSync(pastaDestino)) return;

    let arquivos = fs.readdirSync(pastaDestino).filter(arq => path.extname(arq) === '.zip');
    const tempoAtual = Date.now();
    const tempoLimiteEmMilissegundos = DIAS_RETENCAO * 24 * 60 * 60 * 1000;
    let apagadosPorIdade = 0;

    // 1ª FASE: Limpeza por limite de dias
    arquivos.forEach(arquivo => {
        const caminhoArquivo = path.join(pastaDestino, arquivo);
        const informacoesArquivo = fs.statSync(caminhoArquivo);
        const idadeDoArquivo = tempoAtual - informacoesArquivo.mtimeMs;

        if (idadeDoArquivo > tempoLimiteEmMilissegundos) {
            try {
                fs.unlinkSync(caminhoArquivo);
                console.log(`[LIXEIRA] Backup antigo removido (> ${DIAS_RETENCAO} dias): ${arquivo}`);
                apagadosPorIdade++;
            } catch (err) {
                console.error(`[ERRO] Não foi possível apagar ${arquivo}:`, err.message);
            }
        }
    });

    if (apagadosPorIdade === 0) {
        console.log('[INFO] Nenhum backup estourou o limite de dias.');
    }

    // 2ª FASE: Limpeza de emergência por falta de espaço no HD
    try {
        // Verifica se a versão do Node suporta leitura de disco (Node 19.6+)
        if (typeof fs.statfsSync === 'function') {
            const limiteBytes = LIMITE_ESPACO_LIVRE_GB * 1024 * 1024 * 1024;
            let stats = fs.statfsSync(pastaDestino);
            let espacoLivre = stats.bavail * stats.bsize;
            let apagadosPorEspaco = 0;

            // Enquanto o espaço livre for menor que 1 GB...
            while (espacoLivre < limiteBytes) {
                // Atualiza a lista de arquivos que ainda restam
                arquivos = fs.readdirSync(pastaDestino).filter(arq => path.extname(arq) === '.zip');
                
                if (arquivos.length === 0) {
                    console.log(`[ALERTA MÁXIMO] O disco tem menos de ${LIMITE_ESPACO_LIVRE_GB}GB livre, mas não há mais backups do sistema para apagar!`);
                    break;
                }

                // Lógica para descobrir qual é o arquivo mais antigo da lista
                let arquivoMaisAntigo = arquivos[0];
                let tempoMaisAntigo = fs.statSync(path.join(pastaDestino, arquivoMaisAntigo)).mtimeMs;

                for (let i = 1; i < arquivos.length; i++) {
                    const tempoAtualArq = fs.statSync(path.join(pastaDestino, arquivos[i])).mtimeMs;
                    if (tempoAtualArq < tempoMaisAntigo) {
                        tempoMaisAntigo = tempoAtualArq;
                        arquivoMaisAntigo = arquivos[i];
                    }
                }

                // Apaga o arquivo mais velho encontrado
                const caminhoMaisAntigo = path.join(pastaDestino, arquivoMaisAntigo);
                fs.unlinkSync(caminhoMaisAntigo);
                console.log(`[EMERGÊNCIA] Backup removido por falta de espaço no HD: ${arquivoMaisAntigo}`);
                apagadosPorEspaco++;

                // Calcula o novo espaço livre do HD após apagar o arquivo
                stats = fs.statfsSync(pastaDestino);
                espacoLivre = stats.bavail * stats.bsize;
            }

            // Variável externa para usar no painel de resumo
            global.espacoLivreGB = (espacoLivre / (1024 * 1024 * 1024)).toFixed(2);

        } else {
             console.log('[AVISO] Seu Node.js é antigo e não suporta a verificação de disco nativa. Atualize para a versão 20+ se quiser usar o limite de espaço.');
             global.espacoLivreGB = 'Desconhecido (Node.js antigo)';
        }
    } catch (err) {
         console.error('[ERRO] Falha ao verificar espaço em disco:', err.message);
         global.espacoLivreGB = 'Erro na leitura';
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

    // Compacta as pastas
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

    // Executa as verificações e limpeza de arquivos velhos/espaço no disco
    limparBackupsAntigos(pastaDestinoAtual);

    // ================= PAINEL DE RESUMO =================
    console.log('\n--- RESUMO DO SISTEMA ---');
    console.log(`📅 Intervalo de Execução: ${INTERVALO}`);
    console.log(`📂 Destino Atual: ${pastaDestinoAtual}`);
    console.log(`💾 Espaço Livre no Disco: ${global.espacoLivreGB || '?'} GB (Mínimo exigido: ${LIMITE_ESPACO_LIVRE_GB} GB)`);
    console.log(`🗑️  Idade Máxima do Backup: ${DIAS_RETENCAO} dias`);
    console.log(`📁 Pastas Sincronizadas (${caminhos.length}):`);
    caminhos.forEach(pasta => console.log(`   - ${pasta}`));
    console.log('=================================================\n');
}

console.log(`Serviço de backup iniciado. Aguardando o intervalo programado (${INTERVALO})...`);

cron.schedule(INTERVALO, () => {
    fazerBackup();
});