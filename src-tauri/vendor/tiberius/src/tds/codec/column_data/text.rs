use crate::{sql_read_bytes::SqlReadBytes, tds::Collation, ColumnData};

pub(crate) async fn decode<R>(
    src: &mut R,
    collation: Option<Collation>,
) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let ptr_len = src.read_u8().await? as usize;

    if ptr_len == 0 {
        return Ok(ColumnData::String(None));
    }

    for _ in 0..ptr_len {
        src.read_u8().await?;
    }

    src.read_i32_le().await?; // days
    src.read_u32_le().await?; // second fractions

    let text = match collation {
        // TEXT
        Some(collation) => {
            let encoder = collation.encoding()?;
            let text_len = src.read_u32_le().await? as usize;
            let mut buf = Vec::with_capacity(text_len);

            for _ in 0..text_len {
                buf.push(src.read_u8().await?);
            }

            // [db-studio 패치] string.rs 와 같은 이유로 풀 수 없는 바이트는 U+FFFD 로 바꾼다.
            encoder.decode_without_bom_handling(buf.as_ref()).0.into_owned()
        }
        // NTEXT
        None => {
            let text_len = src.read_u32_le().await? as usize / 2;
            let mut buf = Vec::with_capacity(text_len);

            for _ in 0..text_len {
                buf.push(src.read_u16_le().await?);
            }

            // [db-studio 패치] 짝 없는 서로게이트도 U+FFFD 로 바꾼다.
            String::from_utf16_lossy(&buf[..])
        }
    };

    Ok(ColumnData::String(Some(text.into())))
}
